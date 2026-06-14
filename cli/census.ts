#!/usr/bin/env bun
/**
 * census — a tight write -> validate -> build loop for chart authors.
 *
 * Usage: bun cli/census.ts <command> [args]
 *
 *   validate <file>      parse + validate a chart TOML (schema, aliases, geo)
 *   resolve "<place>"    print the resolved GEOID + gazetteer row
 *   metrics              list registry aliases and supported datasets
 *   build <file>         run the full pipeline, write tidy JSON to .cache/charts
 *   new <slug>           scaffold a valid skeleton TOML in charts/
 *   screenshot <file>    headless-render the chart to a PNG (optional)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChartSpecError, parseChartSpec } from '../src/lib/census/schema.ts';
import { resolveGeography } from '../src/lib/census/geography.ts';
import { isDatasetSupported, listMetrics, resolveMetricCode } from '../src/lib/census/registry.ts';
import { compileChart, resolveSpec } from '../src/lib/census/compile.ts';
import { stateFips } from '../src/lib/census/states.ts';
import type { ChartSpec, MapChartSpec } from '../src/lib/census/types.ts';

const c = {
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`
};

function fail(messages: string[]): never {
	for (const m of messages) console.error(`  ${c.red('✗')} ${m}`);
	process.exit(1);
}

async function cmdValidate(file?: string): Promise<void> {
	if (!file) fail(['usage: census validate <file>']);
	let raw: string;
	try {
		raw = await readFile(file!, 'utf8');
	} catch {
		fail([`cannot read file: ${file}`]);
	}

	let spec: ChartSpec;
	try {
		spec = parseChartSpec(raw!, { filename: file });
	} catch (err) {
		if (err instanceof ChartSpecError) {
			console.error(`${c.red('✗')} ${file} failed validation:`);
			fail(err.issues);
		}
		fail([(err as Error).message]);
	}

	if (spec!.kind === 'map') {
		validateMap(spec!, file!);
		return;
	}

	const { geos, metric, years, errors, warnings } = resolveSpec(spec!);
	for (const w of warnings) console.warn(`  ${c.yellow('!')} ${w}`);
	if (errors.length > 0) {
		console.error(`${c.red('✗')} ${file} failed validation:`);
		fail(errors);
	}

	console.log(`${c.green('✓')} ${c.bold(spec!.id)} — ${spec!.title}`);
	console.log(
		c.dim(
			`  ${spec!.kind} · ${spec!.query.dataset} · ${spec!.query.metric}` +
				(metric ? ` (${metric.code})` : '') +
				` · ${years.length} year(s) [${years[0]}…${years.at(-1)}]`
		)
	);
	for (const g of geos) {
		console.log(c.dim(`  ✓ ${g.input} → ${g.name} (GEOID ${g.geoid})`));
	}
}

/** Offline validation + summary for a map spec (no fetch, no geometry needed). */
function validateMap(spec: MapChartSpec, file: string): void {
	const errors: string[] = [];
	let code: string | undefined;
	let extentDesc = '';

	if (!isDatasetSupported(spec.query.dataset)) {
		errors.push(`dataset "${spec.query.dataset}" is not supported yet (v1 covers acs5, acs1).`);
	} else {
		try {
			code = resolveMetricCode(spec.query.metric, spec.query.dataset).code;
		} catch (err) {
			errors.push((err as Error).message);
		}
	}

	const within = spec.map.within.trim();
	try {
		if (within.toUpperCase() === 'US') {
			extentDesc = 'national';
		} else if (spec.map.level === 'tract') {
			const g = resolveGeography(within);
			extentDesc = `${g.name} (${g.geoid})`;
		} else {
			const ss = stateFips(within);
			if (!ss) throw new Error(`map.within "${within}" is not a recognized state code.`);
			extentDesc = `${within.toUpperCase()} (state ${ss})`;
		}
	} catch (err) {
		errors.push((err as Error).message);
	}

	if (errors.length > 0) {
		console.error(`${c.red('✗')} ${file} failed validation:`);
		fail(errors);
	}

	const ys = spec.query.years;
	const yearDesc = ys.length === 1 ? `${ys[0]}` : `${ys[0]}…${ys.at(-1)} (${ys.length} frames)`;
	console.log(`${c.green('✓')} ${c.bold(spec.id)} — ${spec.title}`);
	console.log(
		c.dim(
			`  map · ${spec.map.level} in ${spec.map.within} · ${spec.query.dataset} · ` +
				`${spec.query.metric}${code ? ` (${code})` : ''} · ${yearDesc}`
		)
	);
	console.log(c.dim(`  extent: ${extentDesc}`));
	console.log(
		c.dim(`  geometry: needs registry/geometry/${spec.map.level}/* (bun scripts/fetch-geometry.ts)`)
	);
}

async function cmdBuild(file?: string): Promise<void> {
	if (!file) fail(['usage: census build <file>']);
	let raw: string;
	try {
		raw = await readFile(file!, 'utf8');
	} catch {
		fail([`cannot read file: ${file}`]);
	}

	let spec: ChartSpec;
	try {
		spec = parseChartSpec(raw!, { filename: file });
	} catch (err) {
		if (err instanceof ChartSpecError) {
			console.error(`${c.red('✗')} ${file} failed validation:`);
			fail(err.issues);
		}
		fail([(err as Error).message]);
	}

	let payload;
	try {
		payload = await compileChart(spec!);
	} catch (err) {
		console.error(`${c.red('✗')} build failed:`);
		fail((err as { issues?: string[] }).issues ?? [(err as Error).message]);
	}

	const outDir = join(process.cwd(), '.cache', 'charts');
	await mkdir(outDir, { recursive: true });
	const outFile = join(outDir, `${payload!.id}.json`);
	await writeFile(outFile, JSON.stringify(payload, null, 2));

	for (const w of payload!.warnings) console.warn(`  ${c.yellow('!')} ${w}`);

	if (payload!.kind === 'map') {
		const feats = payload!.features.features;
		const years = payload!.years;
		const lastFrame = payload!.frames[years[years.length - 1]];
		const withData = feats.filter((f) => lastFrame[f.properties.GEOID] != null).length;
		const yearDesc = years.length === 1 ? `${years[0]}` : `${years[0]}…${years.at(-1)}`;
		console.log(
			`${c.green('✓')} built ${c.bold(payload!.id)} — ${feats.length} areas × ${years.length} frame(s)`
		);
		console.log(
			c.dim(`  metric: ${payload!.metric.label} (${payload!.metric.code}) · ${yearDesc}`)
		);
		console.log(
			c.dim(
				`  ${withData}/${feats.length} areas have data (latest) · domain [${payload!.domain.join(' – ')}]`
			)
		);
		// Sample a few areas across the year range as a sanity check.
		const sample = feats.slice(0, 4);
		console.log(c.dim('  ' + ['area', ...years].join('\t')));
		for (const f of sample) {
			const cells = years.map((y) => payload!.frames[y][f.properties.GEOID] ?? '—');
			console.log(c.dim(`  ${f.properties.NAME}\t${cells.join('\t')}`));
		}
		console.log(c.dim(`\n  → ${outFile}`));
		return;
	}

	console.log(`${c.green('✓')} built ${c.bold(payload!.id)} — ${payload!.data.length} tidy rows`);
	console.log(c.dim(`  metric: ${payload!.metric.label} (${payload!.metric.code})`));

	// Print a compact pivot table (years × series) as a sanity check.
	const years = [...new Set(payload!.data.map((r) => r.year))].sort((a, b) => a - b);
	const header = ['year', ...payload!.series.map((s) => s.label)].join('\t');
	console.log(c.dim('  ' + header));
	for (const y of years) {
		const cells = payload!.series.map((s) => {
			const row = payload!.data.find((r) => r.year === y && r.series === s.key);
			return row?.value ?? '—';
		});
		console.log(c.dim(`  ${y}\t${cells.join('\t')}`));
	}
	console.log(c.dim(`\n  → ${outFile}`));
}

async function cmdResolve(place?: string): Promise<void> {
	if (!place) fail(['usage: census resolve "<place>"  (e.g. "Rogers, AR")']);
	try {
		const g = resolveGeography(place!);
		console.log(`${c.green('✓')} ${c.bold(g.name)} — ${g.state}`);
		console.log(c.dim(`  type:      ${g.type}`));
		console.log(c.dim(`  geoid:     ${g.geoid}`));
		console.log(
			c.dim(
				`  fips:      state=${g.stateFips}` +
					(g.placeFips ? ` place=${g.placeFips}` : '') +
					(g.countyFips ? ` county=${g.countyFips}` : '')
			)
		);
	} catch (err) {
		fail([(err as Error).message]);
	}
}

function cmdMetrics(): void {
	const metrics = listMetrics();
	console.log(c.bold('Registry metrics:'));
	for (const m of metrics) {
		console.log(`  ${c.cyan(m.alias)} ${c.dim(`— ${m.label}`)}`);
		console.log(c.dim(`      datasets: ${m.datasets.join(', ')}`));
	}
}

async function cmdNew(slug?: string): Promise<void> {
	if (!slug) fail(['usage: census new <slug>']);
	const safe = slug!
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	if (!safe) fail([`"${slug}" does not produce a valid slug`]);

	const dir = join(process.cwd(), 'charts');
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${safe}.toml`);
	try {
		await readFile(file, 'utf8');
		fail([`charts/${safe}.toml already exists`]);
	} catch {
		// good — doesn't exist
	}

	const title = safe.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
	const skeleton = `[chart]
title = "${title}"
kind = "line"               # line | bar | area | scatter
description = ""

[query]
metric = "population"       # run \`census metrics\` to list aliases
dataset = "acs5"            # acs5 | acs1
years = "2019..2023"        # range "a..b" OR a list [2019, 2021, 2023]

[[series]]
place = "Rogers, AR"        # friendly "Name, ST"; run \`census resolve "..."\`

[[series]]
place = "Springdale, AR"

[options]
y_label = "Population"
show_margin_of_error = false
`;
	await writeFile(file, skeleton);
	console.log(`${c.green('✓')} created ${c.bold(`charts/${safe}.toml`)}`);
	console.log(c.dim(`  next: edit it, then \`census validate charts/${safe}.toml\``));
}

function usage(): never {
	console.log(`${c.bold('census')} — census chart toolkit

${c.cyan('validate')} <file>      parse + validate a chart TOML
${c.cyan('resolve')} "<place>"    print the resolved GEOID + gazetteer row
${c.cyan('metrics')}              list registry aliases and supported datasets
${c.cyan('build')} <file>         run the full pipeline, write tidy JSON
${c.cyan('new')} <slug>           scaffold a skeleton TOML in charts/
${c.cyan('screenshot')} <file>    headless-render the chart to a PNG`);
	process.exit(0);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case 'validate':
		await cmdValidate(args[0]);
		break;
	case 'resolve':
		await cmdResolve(args[0]);
		break;
	case 'metrics':
		cmdMetrics();
		break;
	case 'build':
		await cmdBuild(args[0]);
		break;
	case 'new':
		await cmdNew(args[0]);
		break;
	case 'screenshot':
		fail([`"${command}" is not implemented yet`]);
		break;
	case undefined:
	case 'help':
	case '--help':
	case '-h':
		usage();
		break;
	default:
		fail([`unknown command: ${command}`, 'run `census help` for usage']);
}
