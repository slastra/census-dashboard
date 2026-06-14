/**
 * Parse + validate a TOML chart file into a normalized ChartSpec.
 *
 * The hard rules (from the build spec) are enforced here so the CLI `validate`
 * command can give an AI author actionable feedback before anything is fetched:
 *  - No FIPS codes or Census variable codes are ever valid. Only friendly
 *    aliases and "Name, ST" place strings.
 *  - `kind` and `dataset` are closed enums.
 *  - `years` accepts a "a..b" range string OR an integer array; both normalize
 *    to a sorted, de-duplicated integer list.
 *  - Every [[series]] needs a `place`; `label` is optional.
 *  - `id` must be a slug; it defaults to the filename slug when omitted.
 */

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import {
	CHART_KINDS,
	DATASETS,
	GEO_LEVELS,
	type ChartSpec,
	type GeoLevel,
	type SeriesKind
} from './types.js';

/** Thrown when a chart file fails validation. Carries every issue found. */
export class ChartSpecError extends Error {
	issues: string[];
	constructor(issues: string[]) {
		super(issues.join('\n'));
		this.name = 'ChartSpecError';
		this.issues = issues;
	}
}

/** Friendly metric/geography alias: lowercase, starts with a letter. */
const ALIAS_RE = /^[a-z][a-z0-9_]*$/;
/** Census variable code shape, e.g. B01003_001E, P1_001N, P001001. */
const VAR_CODE_RE = /^[A-Z][A-Z0-9]*\d{2,}[A-Z0-9_]*$/;
/** "Name, ST" — anything, comma, two-letter state. */
const PLACE_RE = /^\s*[^,]+,\s*[A-Za-z]{2}\s*$/;
/** A run of digits long enough to look like a FIPS/GEOID code. */
const FIPS_RE = /\d{4,}/;
/** Valid id slug: lowercase alphanumerics separated by single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(input: string): string {
	return input
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/** Strip a `.toml` extension and slugify the remaining basename. */
export function slugFromFilename(filename: string): string {
	const base = filename.split(/[/\\]/).pop() ?? filename;
	return slugify(base.replace(/\.toml$/i, ''));
}

const seriesSchema = z.object({
	place: z.string({ error: 'series.place is required' }).min(1, 'series.place cannot be empty'),
	label: z.string().min(1).optional()
});

/** Header + common query fields shared by every kind. Kind-specific fields
 *  (years/year, series/map) are read from the raw object and validated by kind. */
const headerSchema = z.object({
	chart: z.object({
		id: z.string().optional(),
		title: z.string({ error: 'chart.title is required' }).min(1, 'chart.title cannot be empty'),
		kind: z.enum(CHART_KINDS, {
			error: `chart.kind must be one of: ${CHART_KINDS.join(', ')}`
		}),
		description: z.string().optional(),
		created: z.string().optional()
	}),
	query: z.object({
		metric: z.string({ error: 'query.metric is required' }).min(1),
		dataset: z.enum(DATASETS, {
			error: `query.dataset must be one of: ${DATASETS.join(', ')}`
		})
	}),
	options: z
		.object({
			y_label: z.string().optional(),
			show_margin_of_error: z.boolean().optional()
		})
		.optional()
});

const mapSchema = z.object({
	level: z.enum(GEO_LEVELS, { error: `map.level must be one of: ${GEO_LEVELS.join(', ')}` }),
	within: z.string({ error: 'map.within is required' }).min(1)
});

/** Normalize a years value (range string or array) into a sorted int list. */
function normalizeYears(years: unknown, issues: string[]): number[] {
	const out = new Set<number>();

	if (typeof years !== 'string' && !Array.isArray(years)) {
		issues.push('query.years must be a range string "a..b" or an array of years');
		return [];
	}

	const pushYear = (v: number | string) => {
		const n = typeof v === 'number' ? v : Number(v);
		if (!Number.isInteger(n) || n < 1900 || n > 2100) {
			issues.push(`query.years: "${v}" is not a valid 4-digit year`);
			return;
		}
		out.add(n);
	};

	if (typeof years === 'string') {
		const m = years.match(/^\s*(\d{4})\s*\.\.\s*(\d{4})\s*$/);
		if (!m) {
			issues.push(`query.years: "${years}" is not a valid range. Use "2010..2023".`);
			return [];
		}
		const [, aStr, bStr] = m;
		const a = Number(aStr);
		const b = Number(bStr);
		if (a > b) {
			issues.push(`query.years: range start ${a} is after end ${b}`);
			return [];
		}
		for (let y = a; y <= b; y++) out.add(y);
	} else {
		if (years.length === 0) issues.push('query.years: array cannot be empty');
		for (const v of years) pushYear(v);
	}

	return [...out].sort((x, y) => x - y);
}

/** Reject metric values that look like Census variable codes rather than aliases. */
function validateMetric(metric: string, issues: string[]): void {
	if (ALIAS_RE.test(metric)) return;
	if (VAR_CODE_RE.test(metric)) {
		issues.push(
			`query.metric "${metric}" looks like a Census variable code. Use a friendly alias (e.g. "population") — run \`census metrics\` to list them.`
		);
	} else {
		issues.push(
			`query.metric "${metric}" is not a valid alias. Use lowercase letters, digits and underscores (e.g. "median_household_income").`
		);
	}
}

/** Reject place values that contain FIPS codes or aren't "Name, ST" strings. */
function validatePlace(place: string, index: number, issues: string[]): void {
	const where = `series[${index}].place`;
	if (FIPS_RE.test(place)) {
		issues.push(
			`${where} "${place}" contains what looks like a FIPS/GEOID code. Use a friendly place name (e.g. "Rogers, AR").`
		);
		return;
	}
	if (!PLACE_RE.test(place)) {
		issues.push(
			`${where} "${place}" must be a "Name, ST" string with a two-letter state (e.g. "Rogers, AR" or "Benton County, AR").`
		);
	}
}

/** Validate a single integer year for maps. */
function validateYear(year: unknown, issues: string[]): number {
	const n = typeof year === 'number' ? year : Number(year);
	if (year === undefined) {
		issues.push('query.year is required for a map (a single year, e.g. 2023)');
		return NaN;
	}
	if (!Number.isInteger(n) || n < 1900 || n > 2100) {
		issues.push(`query.year "${year}" is not a valid 4-digit year`);
	}
	return n;
}

const STATE_CODE_RE = /^[A-Z]{2}$/;

/** Validate the `level` x `within` matrix for a map, rejecting FIPS codes. */
function validateMapExtent(level: GeoLevel, within: string, issues: string[]): void {
	const w = within.trim();
	if (FIPS_RE.test(w)) {
		issues.push(
			`map.within "${within}" contains what looks like a FIPS code. Use "US", a state code (e.g. "AR"), or a county (e.g. "Benton County, AR").`
		);
		return;
	}
	const isUS = w.toUpperCase() === 'US';
	const isState = !isUS && STATE_CODE_RE.test(w.toUpperCase());
	const isCountyish = PLACE_RE.test(w);

	switch (level) {
		case 'state':
			if (!isUS) issues.push('map.level "state" requires map.within = "US".');
			break;
		case 'county':
			if (!isUS && !isState)
				issues.push('map.level "county" requires map.within = "US" or a state code (e.g. "AR").');
			break;
		case 'place':
			if (!isState)
				issues.push('map.level "place" requires map.within = a state code (e.g. "AR").');
			break;
		case 'tract':
			if (!isCountyish)
				issues.push('map.level "tract" requires map.within = a county (e.g. "Benton County, AR").');
			break;
	}
}

/** Format zod issues into friendly, path-prefixed messages. */
function formatZodIssues(error: z.ZodError): string[] {
	return error.issues.map((issue) => {
		const path = issue.path.join('.');
		return path ? `${path}: ${issue.message}` : issue.message;
	});
}

export interface ParseOptions {
	/** Used to default `chart.id` when omitted. */
	filename?: string;
}

/**
 * Parse + validate raw TOML into a ChartSpec. Throws ChartSpecError with the
 * full list of issues on any failure.
 */
export function parseChartSpec(rawToml: string, opts: ParseOptions = {}): ChartSpec {
	let data: unknown;
	try {
		data = parseToml(rawToml);
	} catch (err) {
		throw new ChartSpecError([`TOML syntax error: ${(err as Error).message}`]);
	}

	const parsed = headerSchema.safeParse(data);
	if (!parsed.success) {
		throw new ChartSpecError(formatZodIssues(parsed.error));
	}

	const raw = parsed.data;
	// Kind-specific fields live outside the header schema; read them raw.
	const root = (data ?? {}) as {
		query?: { years?: unknown; year?: unknown };
		series?: unknown;
		map?: unknown;
	};
	const issues: string[] = [];

	// id: explicit slug, or default from filename.
	let id = raw.chart.id;
	if (id !== undefined) {
		if (!SLUG_RE.test(id)) {
			issues.push(
				`chart.id "${id}" must be a slug (lowercase letters, digits, single hyphens), e.g. "rogers-vs-springdale-population".`
			);
		}
	} else if (opts.filename) {
		id = slugFromFilename(opts.filename);
		if (!id) issues.push(`could not derive a chart.id slug from filename "${opts.filename}"`);
	} else {
		issues.push('chart.id is required when no filename is available to derive it from');
	}

	validateMetric(raw.query.metric, issues);

	const base = {
		id: id!,
		title: raw.chart.title,
		description: raw.chart.description,
		created: raw.chart.created,
		options: {
			y_label: raw.options?.y_label,
			show_margin_of_error: raw.options?.show_margin_of_error ?? false
		}
	};
	const query = { metric: raw.query.metric, dataset: raw.query.dataset };

	if (raw.chart.kind === 'map') {
		if (root.series !== undefined) issues.push('a map does not use [[series]]; remove it.');

		// A map takes a single `year` (static) or `years` (range/list → animated).
		let years: number[] = [];
		if (root.query?.years !== undefined) {
			years = normalizeYears(root.query.years, issues);
		} else if (root.query?.year !== undefined) {
			const y = validateYear(root.query.year, issues);
			if (!Number.isNaN(y)) years = [y];
		} else {
			issues.push(
				'a map needs query.year (single) or query.years (range/list, e.g. "2015..2023").'
			);
		}

		const mapParsed = mapSchema.safeParse(root.map);
		if (!mapParsed.success) {
			for (const m of formatZodIssues(mapParsed.error)) issues.push(`map.${m}`);
			if (issues.length > 0) throw new ChartSpecError(issues);
		}
		const { level, within } = mapParsed.data!;
		validateMapExtent(level, within, issues);

		if (issues.length > 0) throw new ChartSpecError(issues);
		return {
			...base,
			kind: 'map',
			query: { ...query, years },
			map: { level, within: within.trim() }
		};
	}

	// Series chart kinds (line/bar/area/scatter).
	if (root.map !== undefined) issues.push('[map] is only valid for kind = "map".');
	if (root.query?.years === undefined) issues.push('query.years is required (e.g. "2010..2023").');
	const seriesParsed = z
		.array(seriesSchema, { error: 'at least one [[series]] is required' })
		.min(1, 'at least one [[series]] is required')
		.safeParse(root.series);
	if (!seriesParsed.success) {
		for (const m of formatZodIssues(seriesParsed.error)) issues.push(`series.${m}`);
		if (issues.length > 0) throw new ChartSpecError(issues);
	}

	const years = root.query?.years === undefined ? [] : normalizeYears(root.query.years, issues);
	const series = (seriesParsed.data ?? []).map((s, i) => {
		validatePlace(s.place, i, issues);
		return { place: s.place.trim(), label: s.label };
	});

	if (issues.length > 0) throw new ChartSpecError(issues);

	return {
		...base,
		kind: raw.chart.kind as SeriesKind,
		query: { ...query, years },
		series
	};
}
