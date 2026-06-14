/**
 * Core domain types for the census dashboard.
 *
 * A ChartSpec is the validated, normalized form of a single TOML chart file.
 * It contains only friendly aliases and place names — never FIPS codes or
 * Census variable codes (those are resolved later, in the framework).
 */

export const CHART_KINDS = ['line', 'bar', 'area', 'scatter', 'map'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** Choropleth geography levels (coarsest to finest). */
export const GEO_LEVELS = ['state', 'county', 'place', 'tract'] as const;
export type GeoLevel = (typeof GEO_LEVELS)[number];

export const DATASETS = ['acs5', 'acs1', 'decennial'] as const;
export type Dataset = (typeof DATASETS)[number];

/**
 * Datasets wired up end-to-end in v1. Decennial is deferred: the metric
 * registry keeps its `decennial_*` keys for forward-compatibility, but the
 * client/compile path does not yet support its per-vintage endpoints.
 */
export const SUPPORTED_DATASETS = ['acs5', 'acs1'] as const satisfies readonly Dataset[];

export interface SeriesSpec {
	/** Friendly geography string, e.g. "Rogers, AR". Resolved offline to a GEOID. */
	place: string;
	/** Optional display override; defaults to the resolved geography name. */
	label?: string;
}

export interface ChartOptions {
	/** Y-axis label. */
	y_label?: string;
	/** If true and the dataset is ACS, fetch + render the margin-of-error band. */
	show_margin_of_error: boolean;
}

/** Series (time-over-geography) chart kinds — everything except `map`. */
export const SERIES_KINDS = ['line', 'bar', 'area', 'scatter'] as const;
export type SeriesKind = (typeof SERIES_KINDS)[number];

export interface SeriesQuery {
	/** Metric alias resolved via the registry, e.g. "population". */
	metric: string;
	dataset: Dataset;
	/** Normalized to a sorted, de-duplicated list of integer years. */
	years: number[];
}

export interface MapQuery {
	metric: string;
	dataset: Dataset;
	/** One or more years. A single year is a static map; many animate as frames. */
	years: number[];
}

export interface MapExtent {
	level: GeoLevel;
	/** "US" | "<state>" (e.g. "AR") | "<county>, <state>" (e.g. "Benton County, AR"). */
	within: string;
}

/** A live chart-file event emitted by the watcher over SSE. */
export interface ChartEvent {
	type: 'add' | 'change' | 'remove';
	id: string;
	title?: string;
	kind?: ChartKind;
}

interface BaseSpec {
	/** Slug (lowercase, hyphens). Defaults to the filename slug if omitted. */
	id: string;
	title: string;
	description?: string;
	/** Optional ISO date string overriding file mtime for newest-first ordering. */
	created?: string;
	options: ChartOptions;
}

/** A time-series chart over a few named geographies (line/bar/area/scatter). */
export interface SeriesChartSpec extends BaseSpec {
	kind: SeriesKind;
	query: SeriesQuery;
	series: SeriesSpec[];
}

/** A choropleth map: one metric, one year, many geographies in an extent. */
export interface MapChartSpec extends BaseSpec {
	kind: 'map';
	query: MapQuery;
	map: MapExtent;
}

export type ChartSpec = SeriesChartSpec | MapChartSpec;
