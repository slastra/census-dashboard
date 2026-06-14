/**
 * Server-side chart catalog: read the watched charts/ directory, expose chart
 * metadata (newest-first) and compiled payloads by id.
 *
 * "Newest" is the file mtime by default; an optional `created` field in the
 * TOML's [chart] table overrides it.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseChartSpec, ChartSpecError } from '$lib/census/schema.js';
import { compileChart, type Payload } from '$lib/census/compile.js';
import type { ChartKind } from '$lib/census/types.js';

export interface ChartMeta {
	id: string;
	title: string;
	kind: ChartKind;
	/** Sort timestamp in ms (created override, else file mtime). */
	sortTime: number;
	/** ISO string for display. */
	updated: string;
}

interface CatalogEntry extends ChartMeta {
	file: string;
}

export function chartsDir(): string {
	return process.env.CHARTS_DIR || join(process.cwd(), 'charts');
}

/** Scan charts/ and return valid chart entries, newest-first. Invalid files are skipped. */
async function scan(): Promise<CatalogEntry[]> {
	let files: string[];
	try {
		files = (await readdir(chartsDir())).filter((f) => f.toLowerCase().endsWith('.toml'));
	} catch {
		return [];
	}

	const entries: CatalogEntry[] = [];
	for (const f of files) {
		const file = join(chartsDir(), f);
		try {
			const raw = await readFile(file, 'utf8');
			const spec = parseChartSpec(raw, { filename: file });
			const s = await stat(file);
			const created = spec.created ? Date.parse(spec.created) : NaN;
			const sortTime = Number.isNaN(created) ? s.mtimeMs : created;
			entries.push({
				id: spec.id,
				title: spec.title,
				kind: spec.kind,
				sortTime,
				updated: new Date(sortTime).toISOString(),
				file
			});
		} catch (err) {
			if (err instanceof ChartSpecError) {
				console.warn(`[charts] skipping invalid ${f}: ${err.issues[0]}`);
			} else {
				console.warn(`[charts] skipping ${f}: ${(err as Error).message}`);
			}
		}
	}

	return entries.sort((a, b) => b.sortTime - a.sortTime);
}

/** Chart metadata, newest-first. */
export async function listCharts(): Promise<ChartMeta[]> {
	return (await scan()).map(({ file, ...meta }) => meta);
}

/** The id of the newest chart, or null if there are none. */
export async function newestChartId(): Promise<string | null> {
	const list = await listCharts();
	return list[0]?.id ?? null;
}

/** Compile a chart by id. Returns null if no chart with that id exists. */
export async function getChartPayload(id: string): Promise<Payload | null> {
	const entry = (await scan()).find((e) => e.id === id);
	if (!entry) return null;
	const raw = await readFile(entry.file, 'utf8');
	const spec = parseChartSpec(raw, { filename: entry.file });
	return compileChart(spec);
}
