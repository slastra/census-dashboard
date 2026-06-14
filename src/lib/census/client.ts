/**
 * Census API client with a filesystem cache.
 *
 * Census vintage data is immutable, so cache entries never expire. Each API
 * call is cached by hash(dataset, year, sorted variables, sorted geoids).
 *
 * Geographies are batched per (state, type) within a year: the API's `in=state`
 * clause takes a single state, so series spanning multiple states become
 * multiple calls. Years always require separate calls per vintage.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedGeography } from './geography.js';
import type { GeoLevel } from './types.js';

/** Census sentinel for "not available" annotation values (e.g. -666666666). */
export function coerceValue(raw: string | number | null | undefined): number | null {
	if (raw === null || raw === undefined || raw === '') return null;
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n)) return null;
	// All metrics we support are non-negative; Census uses large negative
	// sentinels (-666666666, -999999999, -222222222, …) for missing data.
	if (n <= -1_000_000) return null;
	return n;
}

export interface CensusDatum {
	value: number | null;
	moe: number | null;
}

export interface FetchYearResult {
	year: number;
	/** Keyed by full GEOID. */
	byGeoid: Map<string, CensusDatum>;
	warnings: string[];
}

export interface FetchYearOptions {
	dataset: 'acs5' | 'acs1';
	year: number;
	/** Estimate variable code, e.g. "B01003_001E". */
	code: string;
	/** Whether to also fetch the matching margin-of-error (M) variable. */
	moe?: boolean;
	geos: ResolvedGeography[];
}

const API_BASE = 'https://api.census.gov/data';

function cacheDir(): string {
	return process.env.CENSUS_CACHE_DIR || join(process.cwd(), '.cache', 'census');
}

function cacheKey(dataset: string, year: number, vars: string[], geoids: string[]): string {
	const payload = JSON.stringify({
		dataset,
		year,
		vars: [...vars].sort(),
		geoids: [...geoids].sort()
	});
	return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** The matching margin-of-error variable for an ACS estimate (E -> M). */
export function moeVariable(code: string): string {
	return code.replace(/E$/, 'M');
}

type CensusRow = Record<string, string>;

/** Build the API path segment for a dataset. */
function datasetPath(dataset: 'acs5' | 'acs1'): string {
	return `acs/${dataset}`;
}

/**
 * Fetch one (dataset, year, vars, group-of-geos) batch — from cache if present,
 * otherwise from the API. Returns the response as an array of row objects.
 */
async function fetchBatch(
	dataset: 'acs5' | 'acs1',
	year: number,
	vars: string[],
	geos: ResolvedGeography[]
): Promise<CensusRow[]> {
	const type = geos[0].type;
	const stateFips = geos[0].stateFips;
	const geoids = geos.map((g) => g.geoid);
	const key = cacheKey(dataset, year, vars, geoids);
	const file = join(cacheDir(), `${key}.json`);

	try {
		const hit = await readFile(file, 'utf8');
		return JSON.parse(hit) as CensusRow[];
	} catch {
		// cache miss — fall through to fetch
	}

	const forIds = geos.map((g) => (type === 'place' ? g.placeFips : g.countyFips)).join(',');
	const url = new URL(`${API_BASE}/${year}/${datasetPath(dataset)}`);
	url.searchParams.set('get', ['NAME', ...vars].join(','));
	url.searchParams.set('for', `${type}:${forIds}`);
	url.searchParams.set('in', `state:${stateFips}`);
	const apiKey = process.env.CENSUS_DATA_API_KEY;
	if (apiKey) url.searchParams.set('key', apiKey);

	const res = await fetch(url);
	const body = await res.text();
	if (!res.ok) {
		throw new Error(
			`Census API ${res.status} for ${dataset} ${year} ${type}:${forIds} — ${body.slice(0, 200)}`
		);
	}
	let matrix: string[][];
	try {
		matrix = JSON.parse(body) as string[][];
	} catch {
		// A keyless/over-quota request is redirected to an HTML page; surface that
		// clearly instead of a raw JSON parse error.
		throw new Error(
			`Census API returned a non-JSON response for ${dataset} ${year} ${type}:${forIds}. ` +
				`Is CENSUS_DATA_API_KEY set? Body starts: ${body.slice(0, 120)}`
		);
	}
	const [header, ...dataRows] = matrix;
	const rows = dataRows.map((cells) => {
		const obj: CensusRow = {};
		header.forEach((h, i) => (obj[h] = cells[i]));
		return obj;
	});

	await mkdir(cacheDir(), { recursive: true });
	await writeFile(file, JSON.stringify(rows));
	return rows;
}

/** Match a response row back to a GEOID using its state + place/county columns. */
function rowGeoid(row: CensusRow, type: 'place' | 'county'): string {
	const state = row['state'] ?? '';
	const sub = type === 'place' ? (row['place'] ?? '') : (row['county'] ?? '');
	return state + sub;
}

/**
 * Fetch a single metric for all geographies in one year, batching per
 * (state, type). Returns a GEOID-keyed map of {value, moe}.
 */
export async function fetchYear(opts: FetchYearOptions): Promise<FetchYearResult> {
	const { dataset, year, code, geos } = opts;
	const moeCode = opts.moe ? moeVariable(code) : undefined;
	const vars = moeCode ? [code, moeCode] : [code];
	const warnings: string[] = [];
	const byGeoid = new Map<string, CensusDatum>();

	// Group geographies by (state, type).
	const groups = new Map<string, ResolvedGeography[]>();
	for (const g of geos) {
		const k = `${g.type}:${g.stateFips}`;
		(groups.get(k) ?? groups.set(k, []).get(k)!).push(g);
	}

	for (const group of groups.values()) {
		const rows = await fetchBatch(dataset, year, vars, group);
		const type = group[0].type;
		for (const row of rows) {
			const geoid = rowGeoid(row, type);
			byGeoid.set(geoid, {
				value: coerceValue(row[code]),
				moe: moeCode ? coerceValue(row[moeCode]) : null
			});
		}
		// Flag any requested geo missing from the response (e.g. acs1 < 65k pop).
		for (const g of group) {
			if (!byGeoid.has(g.geoid)) {
				byGeoid.set(g.geoid, { value: null, moe: null });
				warnings.push(`no ${dataset} ${year} data for ${g.name} (${g.geoid}); emitted null.`);
			}
		}
	}

	return { year, byGeoid, warnings };
}

export interface FetchWildcardOptions {
	dataset: 'acs5' | 'acs1';
	year: number;
	code: string;
	level: GeoLevel;
	/** Required for place/tract; scopes county within a state. */
	stateFips?: string;
	/** Required for tract; scopes tracts within a county. */
	countyFips?: string;
	moe?: boolean;
}

/** Build the full GEOID from a wildcard response row, per level. */
function wildcardGeoid(row: CensusRow, level: GeoLevel): string {
	const s = row['state'] ?? '';
	switch (level) {
		case 'state':
			return s;
		case 'county':
			return s + (row['county'] ?? '');
		case 'place':
			return s + (row['place'] ?? '');
		case 'tract':
			return s + (row['county'] ?? '') + (row['tract'] ?? '');
	}
}

/**
 * Fetch a metric for *all* geographies of a level within an extent (one Census
 * wildcard call). Returns a GEOID-keyed map. Cached like the per-geography path.
 */
export async function fetchWildcard(
	opts: FetchWildcardOptions
): Promise<{ byGeoid: Map<string, CensusDatum>; warnings: string[] }> {
	const { dataset, year, code, level, stateFips, countyFips } = opts;
	const moeCode = opts.moe ? moeVariable(code) : undefined;
	const vars = moeCode ? [code, moeCode] : [code];
	const warnings: string[] = [];

	const extent = `${level}:${stateFips ?? 'us'}:${countyFips ?? ''}`;
	const key = createHash('sha256')
		.update(JSON.stringify({ dataset, year, vars: [...vars].sort(), extent }))
		.digest('hex')
		.slice(0, 32);
	const file = join(cacheDir(), `wild_${key}.json`);

	let rows: CensusRow[];
	try {
		rows = JSON.parse(await readFile(file, 'utf8')) as CensusRow[];
	} catch {
		const url = new URL(`${API_BASE}/${year}/${datasetPath(dataset)}`);
		url.searchParams.set('get', ['NAME', ...vars].join(','));
		url.searchParams.set('for', `${level}:*`);
		// Hierarchy: place needs state; tract needs state + county.
		if (level === 'tract') {
			if (!stateFips || !countyFips) throw new Error('tract wildcard requires state + county');
			url.searchParams.append('in', `state:${stateFips}`);
			url.searchParams.append('in', `county:${countyFips}`);
		} else if (level === 'place') {
			if (!stateFips) throw new Error('place wildcard requires a state');
			url.searchParams.set('in', `state:${stateFips}`);
		} else if (level === 'county' && stateFips) {
			url.searchParams.set('in', `state:${stateFips}`);
		}
		const apiKey = process.env.CENSUS_DATA_API_KEY;
		if (apiKey) url.searchParams.set('key', apiKey);

		const res = await fetch(url);
		const body = await res.text();
		if (!res.ok) {
			throw new Error(`Census API ${res.status} for ${level}:* ${year} — ${body.slice(0, 200)}`);
		}
		let matrix: string[][];
		try {
			matrix = JSON.parse(body) as string[][];
		} catch {
			throw new Error(
				`Census API returned a non-JSON response for ${level}:* ${year}. ` +
					`Is CENSUS_DATA_API_KEY set? Body starts: ${body.slice(0, 120)}`
			);
		}
		const [header, ...dataRows] = matrix;
		rows = dataRows.map((cells) => {
			const obj: CensusRow = {};
			header.forEach((h, i) => (obj[h] = cells[i]));
			return obj;
		});
		await mkdir(cacheDir(), { recursive: true });
		await writeFile(file, JSON.stringify(rows));
	}

	const byGeoid = new Map<string, CensusDatum>();
	for (const row of rows) {
		byGeoid.set(wildcardGeoid(row, level), {
			value: coerceValue(row[code]),
			moe: moeCode ? coerceValue(row[moeCode]) : null
		});
	}
	return { byGeoid, warnings };
}
