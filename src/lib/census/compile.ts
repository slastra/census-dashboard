/**
 * The compiler: a validated ChartSpec -> a render-ready ChartPayload.
 *
 * Stages, each individually testable:
 *  1. Resolve  — metric alias -> variable code; each place -> GEOID.
 *  2. Fetch    — one cached Census call per (year, state, type) batch.
 *  3. Normalize — assemble a tidy long-format dataset, one row per
 *                 {series, year, value, moe}; sentinels already coerced to null.
 *  4. Map      — attach series metadata + on-palette colors for LayerChart.
 */

import type { FeatureCollection, Geometry } from 'geojson';
import { GeographyError, resolveGeography, type ResolvedGeography } from './geography.js';
import { loadGeometry } from './geometry.js';
import {
	RegistryError,
	isDatasetSupported,
	resolveMetricCode,
	type ResolvedMetric
} from './registry.js';
import { fetchWildcard, fetchYear } from './client.js';
import { stateFips } from './states.js';
import type {
	ChartOptions,
	ChartSpec,
	GeoLevel,
	MapChartSpec,
	SeriesChartSpec,
	SeriesKind
} from './types.js';

export interface ResolveResult {
	metric?: ResolvedMetric;
	geos: ResolvedGeography[];
	/** Years actually fetched (after dataset coverage adjustments). */
	years: number[];
	errors: string[];
	warnings: string[];
}

/** Resolve metric + geographies + year coverage for a series spec, collecting issues. */
export function resolveSpec(spec: SeriesChartSpec): ResolveResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const geos: ResolvedGeography[] = [];
	let metric: ResolvedMetric | undefined;
	let years = [...spec.query.years];

	if (!isDatasetSupported(spec.query.dataset)) {
		errors.push(
			`dataset "${spec.query.dataset}" is not supported yet (v1 covers acs5, acs1). ` +
				`The registry keeps decennial codes for later.`
		);
	}

	if (spec.query.dataset === 'acs1') {
		if (years.includes(2020)) {
			warnings.push('acs1: standard 2020 estimates were not released; dropping 2020.');
			years = years.filter((y) => y !== 2020);
		}
		warnings.push('acs1: only published for geographies with population ≥ 65,000.');
	}

	if (isDatasetSupported(spec.query.dataset)) {
		try {
			metric = resolveMetricCode(spec.query.metric, spec.query.dataset);
		} catch (err) {
			errors.push((err as RegistryError).message);
		}
	}

	for (const s of spec.series) {
		try {
			geos.push(resolveGeography(s.place));
		} catch (err) {
			errors.push((err as GeographyError).message);
		}
	}

	return { metric, geos, years, errors, warnings };
}

export class CompileError extends Error {
	issues: string[];
	constructor(issues: string[]) {
		super(issues.join('\n'));
		this.name = 'CompileError';
		this.issues = issues;
	}
}

export interface TidyRow {
	series: string;
	year: number;
	value: number | null;
	moe: number | null;
}

export interface ChartSeriesMeta {
	key: string;
	label: string;
	geoid: string;
	/** CSS color token, e.g. "var(--chart-1)". */
	color: string;
}

export interface ChartPayload {
	id: string;
	title: string;
	kind: SeriesKind;
	description?: string;
	options: ChartOptions;
	metric: { alias: string; label: string; code: string };
	series: ChartSeriesMeta[];
	/** Tidy long-format data, sorted by series then year. */
	data: TidyRow[];
	warnings: string[];
}

const CHART_COLORS = [
	'var(--chart-1)',
	'var(--chart-2)',
	'var(--chart-3)',
	'var(--chart-4)',
	'var(--chart-5)'
];

/** Run the series pipeline for a validated spec. Throws CompileError on resolve failure. */
export async function compileSeries(spec: SeriesChartSpec): Promise<ChartPayload> {
	const resolved = resolveSpec(spec);
	if (resolved.errors.length > 0) throw new CompileError(resolved.errors);

	const metric = resolved.metric!;
	const dataset = spec.query.dataset as 'acs5' | 'acs1';
	const warnings = [...resolved.warnings];

	// Series metadata: stable label (override or resolved name) + palette color.
	const series: ChartSeriesMeta[] = spec.series.map((s, i) => {
		const geo = resolved.geos[i];
		return {
			key: s.label ?? geo.displayName,
			label: s.label ?? geo.displayName,
			geoid: geo.geoid,
			color: CHART_COLORS[i % CHART_COLORS.length]
		};
	});

	// Fetch every year (one batched call per state/type group within fetchYear).
	const data: TidyRow[] = [];
	for (const year of resolved.years) {
		const result = await fetchYear({
			dataset,
			year,
			code: metric.code,
			moe: spec.options.show_margin_of_error,
			geos: resolved.geos
		});
		warnings.push(...result.warnings);
		series.forEach((sm) => {
			const datum = result.byGeoid.get(sm.geoid);
			data.push({
				series: sm.key,
				year,
				value: datum?.value ?? null,
				moe: datum?.moe ?? null
			});
		});
	}

	data.sort((a, b) => (a.series === b.series ? a.year - b.year : a.series.localeCompare(b.series)));

	return {
		id: spec.id,
		title: spec.title,
		kind: spec.kind,
		description: spec.description,
		options: spec.options,
		metric: { alias: metric.alias, label: metric.label, code: metric.code },
		series,
		data,
		warnings
	};
}

// ---------------------------------------------------------------------------
// Map (choropleth) pipeline
// ---------------------------------------------------------------------------

/** Per-feature geometry properties carried in a MapPayload's GeoJSON. */
export interface MapFeatureProps {
	GEOID: string;
	NAME: string;
}

/** One animation frame: a metric value per GEOID for a single year. */
export type MapFrame = Record<string, number | null>;

export interface MapPayload {
	kind: 'map';
	id: string;
	title: string;
	description?: string;
	options: ChartOptions;
	metric: { alias: string; label: string; code: string };
	/** Sorted years; one frame each. A single year is a static map. */
	years: number[];
	level: GeoLevel;
	within: string;
	/** geoAlbersUsa for national extents; a fitted projection otherwise. */
	projection: 'albersUsa' | 'fit';
	features: FeatureCollection<Geometry, MapFeatureProps>;
	/** year -> { GEOID -> value }. */
	frames: Record<number, MapFrame>;
	/** [min, max] across all years, for a fixed color scale. */
	domain: [number, number];
	warnings: string[];
}

export type Payload = ChartPayload | MapPayload;

interface MapExtentResolved {
	stateFips?: string;
	countyFips?: string;
	/** GEOID prefix selecting the features in scope ('' = national). */
	extentFips: string;
	projection: 'albersUsa' | 'fit';
}

/** Resolve a map's `within` into FIPS scoping + projection choice, per level. */
function resolveMapExtent(spec: MapChartSpec): MapExtentResolved {
	const { level, within } = spec.map;
	if (within.trim().toUpperCase() === 'US') {
		return { extentFips: '', projection: 'albersUsa' };
	}
	if (level === 'tract') {
		const g = resolveGeography(within); // "Benton County, AR" -> county GEOID
		return {
			stateFips: g.stateFips,
			countyFips: g.countyFips,
			extentFips: g.geoid,
			projection: 'fit'
		};
	}
	const ss = stateFips(within.trim());
	if (!ss) throw new CompileError([`map.within "${within}" is not a recognized state code.`]);
	return { stateFips: ss, extentFips: ss, projection: 'fit' };
}

/** Compile a map spec into a choropleth payload (values joined onto geometry). */
export async function compileMap(spec: MapChartSpec): Promise<MapPayload> {
	const warnings: string[] = [];

	if (!isDatasetSupported(spec.query.dataset)) {
		throw new CompileError([
			`dataset "${spec.query.dataset}" is not supported yet (v1 covers acs5, acs1).`
		]);
	}
	let metric: ResolvedMetric;
	try {
		metric = resolveMetricCode(spec.query.metric, spec.query.dataset);
	} catch (err) {
		throw new CompileError([(err as RegistryError).message]);
	}

	let extent: MapExtentResolved;
	try {
		extent = resolveMapExtent(spec);
	} catch (err) {
		if (err instanceof GeographyError) throw new CompileError([err.message]);
		throw err;
	}

	let geo;
	try {
		geo = loadGeometry(spec.map.level, extent.extentFips);
	} catch (err) {
		throw new CompileError([(err as Error).message]);
	}

	// Counties and tracts read better with their descriptive name ("Benton
	// County", "Census Tract 208.6"); places and states use the plain name.
	const useLsad = spec.map.level === 'county' || spec.map.level === 'tract';
	const geoids = geo.features.map((f) => String(f.id ?? f.properties.GEOID));

	// One frame per year (each is one cached Census wildcard call).
	const years = [...spec.query.years].sort((a, b) => a - b);
	const frames: Record<number, MapFrame> = {};
	const allValues: number[] = [];
	for (const year of years) {
		const { byGeoid } = await fetchWildcard({
			dataset: spec.query.dataset as 'acs5' | 'acs1',
			year,
			code: metric.code,
			level: spec.map.level,
			stateFips: extent.stateFips,
			countyFips: extent.countyFips,
			moe: spec.options.show_margin_of_error
		});
		const frame: MapFrame = {};
		for (const geoid of geoids) {
			const v = byGeoid.get(geoid)?.value ?? null;
			frame[geoid] = v;
			if (v != null) allValues.push(v);
		}
		frames[year] = frame;
	}

	const features = geo.features.map((f) => ({
		...f,
		properties: {
			GEOID: String(f.id ?? f.properties.GEOID),
			NAME: (useLsad && f.properties.NAMELSAD) || f.properties.NAME
		}
	}));

	if (allValues.length === 0) {
		warnings.push(`no ${spec.query.dataset} data joined to the geometry.`);
	} else {
		// Report blanks using the most recent frame.
		const last = frames[years[years.length - 1]];
		const blank = geoids.filter((g) => last[g] == null).length;
		if (blank > 0) warnings.push(`${blank} of ${geoids.length} areas have no data (shown blank).`);
	}

	const domain: [number, number] = allValues.length
		? [Math.min(...allValues), Math.max(...allValues)]
		: [0, 1];

	return {
		kind: 'map',
		id: spec.id,
		title: spec.title,
		description: spec.description,
		options: spec.options,
		metric: { alias: metric.alias, label: metric.label, code: metric.code },
		years,
		level: spec.map.level,
		within: spec.map.within,
		projection: extent.projection,
		features: { type: 'FeatureCollection', features },
		frames,
		domain,
		warnings
	};
}

/** Dispatch a validated spec to the series or map pipeline. */
export async function compileChart(spec: ChartSpec): Promise<Payload> {
	return spec.kind === 'map' ? compileMap(spec) : compileSeries(spec);
}
