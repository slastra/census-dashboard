#!/usr/bin/env bun
/**
 * Download Census TIGER cartographic boundary files and convert them to
 * simplified TopoJSON keyed by GEOID, for offline choropleth rendering.
 *
 * Usage:
 *   bun scripts/fetch-geometry.ts state          # national states  -> state/us.json
 *   bun scripts/fetch-geometry.ts county         # national counties -> county/us.json
 *   bun scripts/fetch-geometry.ts place AR       # places in a state -> place/05.json
 *   bun scripts/fetch-geometry.ts tract AR       # tracts in a state -> tract/05.json
 *
 * County maps within a single state reuse the national county file (filtered by
 * GEOID prefix at load time); tract maps within a county reuse the state tract
 * file the same way.
 */

import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { stateFips } from '../src/lib/census/states.ts';

const YEAR = 2023;
const BASE = `https://www2.census.gov/geo/tiger/GENZ${YEAR}/shp`;
const ROOT = join(import.meta.dirname, '..');
const OUT_ROOT = join(ROOT, 'registry', 'geometry');
const MAPSHAPER = join(ROOT, 'node_modules', '.bin', 'mapshaper');

type Level = 'state' | 'county' | 'place' | 'tract';
const NATIONAL: Level[] = ['state', 'county'];
const PER_STATE: Level[] = ['place', 'tract'];

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: 'inherit' });
		p.on('error', reject);
		p.on('close', (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))
		);
	});
}

/** TIGER zip filename + output {dir, extent} for a level + optional state. */
function resolveTarget(level: Level, state?: string) {
	if (NATIONAL.includes(level)) {
		const suffix = level === 'state' ? '20m' : '20m';
		return { zip: `cb_${YEAR}_us_${level}_${suffix}.zip`, dir: level, extent: 'us' };
	}
	if (!state) throw new Error(`level "${level}" requires a state, e.g. \`${level} AR\``);
	const ss = stateFips(state);
	if (!ss) throw new Error(`unknown state code "${state}"`);
	return { zip: `cb_${YEAR}_${ss}_${level}_500k.zip`, dir: level, extent: ss };
}

async function main() {
	const level = process.argv[2] as Level | undefined;
	const state = process.argv[3];
	if (!level || ![...NATIONAL, ...PER_STATE].includes(level)) {
		console.error('usage: fetch-geometry <state|county|place|tract> [stateCode]');
		process.exit(1);
	}

	const { zip, dir, extent } = resolveTarget(level, state);
	const url = `${BASE}/${zip}`;
	const outDir = join(OUT_ROOT, dir);
	await mkdir(outDir, { recursive: true });
	const tmp = join(outDir, '.tmp');
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });

	process.stdout.write(`↓ ${level} (${extent}): ${url}\n`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`failed to download ${url}: HTTP ${res.status}`);
	const zipPath = join(tmp, zip);
	await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
	await run('unzip', ['-o', '-q', '-d', tmp, zipPath]);

	const shp = (await readdir(tmp)).find((f) => f.endsWith('.shp'));
	if (!shp) throw new Error(`no .shp found after unzipping ${zip}`);

	const out = join(outDir, `${extent}.json`);
	// Keep NAMELSAD (the descriptive name: "Benton County", "Census Tract 208.6")
	// where it exists; the national state file only has NAME.
	const fields = level === 'state' ? 'GEOID,NAME' : 'GEOID,NAME,NAMELSAD';
	// Simplify aggressively (8%) but keep every shape; key TopoJSON ids by GEOID;
	// name the layer "geo" so the loader can find it; keep only display fields.
	await run(MAPSHAPER, [
		join(tmp, shp),
		'-simplify',
		'8%',
		'keep-shapes',
		'-filter-fields',
		fields,
		'-rename-layers',
		'geo',
		'-o',
		'format=topojson',
		'id-field=GEOID',
		out
	]);

	await rm(tmp, { recursive: true, force: true });
	await writeFile(
		join(OUT_ROOT, 'VINTAGE.txt'),
		`Census TIGER cartographic boundary files, vintage ${YEAR}.\nSource: ${BASE}/\n`
	);
	console.log(`✓ ${level} (${extent}) -> registry/geometry/${dir}/${extent}.json`);
}

main().catch((err) => {
	console.error(`✗ ${err.message}`);
	process.exit(1);
});
