/**
 * Offline geography resolution: a friendly "Name, ST" string -> a Census GEOID,
 * using the bundled Gazetteer flat files. Deterministic, no network.
 *
 * Ambiguity is a first-class error: if a name matches zero or many rows we throw
 * with the candidate list, so an AI author can disambiguate instead of silently
 * charting the wrong place. This is the single most important reliability guard.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type GeoType = 'place' | 'county';

export interface ResolvedGeography {
	/** The original "Name, ST" input. */
	input: string;
	/** Full Gazetteer name, e.g. "Rogers city" or "Benton County". */
	name: string;
	/** Cleaned name without the LSAD/type suffix, e.g. "Rogers". Used as default label. */
	displayName: string;
	type: GeoType;
	/** Full GEOID (7 digits for places, 5 for counties). */
	geoid: string;
	/** USPS state abbreviation, e.g. "AR". */
	state: string;
	/** 2-digit state FIPS, e.g. "05". */
	stateFips: string;
	/** 5-digit place FIPS (places only). */
	placeFips?: string;
	/** 3-digit county FIPS (counties only). */
	countyFips?: string;
	lat: number;
	lon: number;
}

export class GeographyError extends Error {
	candidates: ResolvedGeography[];
	constructor(message: string, candidates: ResolvedGeography[] = []) {
		super(message);
		this.name = 'GeographyError';
		this.candidates = candidates;
	}
}

/** Trailing place type descriptors stripped to produce a clean display name. */
const PLACE_TYPE_SUFFIXES = [
	'consolidated government',
	'metropolitan government',
	'unified government',
	'metro government',
	'city and borough',
	'urban county',
	'(balance)',
	'municipality',
	'corporation',
	'comunidad',
	'zona urbana',
	'plantation',
	'township',
	'village',
	'borough',
	'city',
	'town',
	'cdp',
	'gore',
	'grant'
];

/** County-like suffixes; their presence routes a name to the counties file. */
const COUNTY_SUFFIX_RE = /\b(county|parish|borough|census area|municipio|municipality|city)$/i;

function stripPlaceType(name: string): string {
	const lower = name.toLowerCase();
	for (const suffix of PLACE_TYPE_SUFFIXES) {
		if (lower.endsWith(' ' + suffix)) {
			return name.slice(0, name.length - suffix.length - 1).trim();
		}
	}
	return name;
}

interface GazRow {
	state: string;
	geoid: string;
	name: string;
}

interface GazTable {
	rows: GazRow[];
	/** name (lowercased, type-stripped) -> rows */
	byCore: Map<string, GazRow[]>;
	/** full name (lowercased) -> rows */
	byFull: Map<string, GazRow[]>;
}

function gazetteerDir(): string {
	return process.env.GAZETTEER_DIR || join(process.cwd(), 'registry', 'gazetteer');
}

const cache = new Map<GeoType, GazTable>();

function loadTable(type: GeoType): GazTable {
	const cached = cache.get(type);
	if (cached) return cached;

	const file = join(gazetteerDir(), type === 'place' ? 'places.txt' : 'counties.txt');
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		throw new GeographyError(
			`Gazetteer file not found: ${file}. Run \`bun scripts/fetch-gazetteer.ts\` first.`
		);
	}

	const lines = text.split(/\r?\n/);
	const header = lines[0].split('\t').map((h) => h.trim());
	const iState = header.indexOf('USPS');
	const iGeoid = header.indexOf('GEOID');
	const iName = header.indexOf('NAME');

	const rows: GazRow[] = [];
	const byCore = new Map<string, GazRow[]>();
	const byFull = new Map<string, GazRow[]>();

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const cols = line.split('\t');
		const name = (cols[iName] ?? '').trim();
		if (!name) continue;
		const row: GazRow = {
			state: (cols[iState] ?? '').trim(),
			geoid: (cols[iGeoid] ?? '').trim(),
			name
		};
		rows.push(row);

		const full = name.toLowerCase();
		(byFull.get(full) ?? byFull.set(full, []).get(full)!).push(row);

		const core = (type === 'place' ? stripPlaceType(name) : name).toLowerCase();
		if (core !== full) {
			(byCore.get(core) ?? byCore.set(core, []).get(core)!).push(row);
		}
	}

	const table: GazTable = { rows, byCore, byFull };
	cache.set(type, table);
	return table;
}

function toResolved(row: GazRow, type: GeoType, input: string): ResolvedGeography {
	const base: ResolvedGeography = {
		input,
		name: row.name,
		displayName: type === 'place' ? stripPlaceType(row.name) : row.name,
		type,
		geoid: row.geoid,
		state: row.state,
		stateFips: row.geoid.slice(0, 2),
		lat: 0,
		lon: 0
	};
	if (type === 'place') base.placeFips = row.geoid.slice(2);
	else base.countyFips = row.geoid.slice(2);
	return base;
}

/** Split "Rogers, AR" into name + two-letter state. */
export function parsePlaceString(input: string): { name: string; state: string } {
	const idx = input.lastIndexOf(',');
	if (idx === -1) {
		throw new GeographyError(
			`"${input}" is missing a state. Use a "Name, ST" string (e.g. "Rogers, AR").`
		);
	}
	const name = input.slice(0, idx).trim();
	const state = input
		.slice(idx + 1)
		.trim()
		.toUpperCase();
	if (!/^[A-Z]{2}$/.test(state)) {
		throw new GeographyError(`"${input}" must end with a two-letter state code (e.g. ", AR").`);
	}
	if (!name) throw new GeographyError(`"${input}" has an empty place name.`);
	return { name, state };
}

/**
 * Resolve a friendly place string to a single GEOID. Throws GeographyError with
 * candidates when the name is missing or ambiguous within the state.
 */
export function resolveGeography(input: string): ResolvedGeography {
	const { name, state } = parsePlaceString(input);
	const type: GeoType = COUNTY_SUFFIX_RE.test(name) ? 'county' : 'place';
	const table = loadTable(type);

	const key = name.toLowerCase();
	const matches = [...(table.byFull.get(key) ?? []), ...(table.byCore.get(key) ?? [])].filter(
		(r) => r.state === state
	);
	// De-dupe (a row can land in both maps).
	const unique = [...new Map(matches.map((r) => [r.geoid, r])).values()];

	if (unique.length === 1) {
		return toResolved(unique[0], type, input);
	}

	if (unique.length === 0) {
		// Offer near-misses: same state, name starts-with the query.
		const near = table.rows
			.filter((r) => r.state === state && r.name.toLowerCase().startsWith(key.slice(0, 4)))
			.slice(0, 8)
			.map((r) => toResolved(r, type, input));
		const hint = near.length
			? ` Did you mean: ${near.map((r) => `"${r.displayName}, ${r.state}"`).join(', ')}?`
			: '';
		throw new GeographyError(`No ${type} named "${name}" found in ${state}.${hint}`, near);
	}

	const candidates = unique.map((r) => toResolved(r, type, input));
	throw new GeographyError(
		`"${input}" is ambiguous — ${candidates.length} matches in ${state}:\n` +
			candidates.map((c) => `    ${c.name} (GEOID ${c.geoid})`).join('\n') +
			`\n  Disambiguate by using the full name including its type (e.g. "${candidates[0].name}, ${state}").`,
		candidates
	);
}
