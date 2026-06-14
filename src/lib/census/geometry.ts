/**
 * Load offline boundary geometry for choropleths.
 *
 * Geometry comes from Census TIGER cartographic boundary files, pre-simplified
 * to TopoJSON keyed by GEOID by `scripts/fetch-geometry.ts`. State and county
 * geometry is national (one file each, filtered by GEOID prefix); place and
 * tract geometry is per-state. Mirrors geography.ts: fetch once, read here, and
 * fail with an actionable message when a file is missing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feature } from 'topojson-client';
import type { Feature, Geometry } from 'geojson';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { GeoLevel } from './types.js';

export interface GeoProps {
	GEOID: string;
	NAME: string;
	/** Descriptive name ("Benton County", "Census Tract 208.6"); absent for states. */
	NAMELSAD?: string;
}
export type GeoFeature = Feature<Geometry, GeoProps>;

export interface LoadedGeometry {
	features: GeoFeature[];
	byGeoid: Map<string, GeoFeature>;
}

export class GeometryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GeometryError';
	}
}

function geometryDir(): string {
	return process.env.GEOMETRY_DIR || join(process.cwd(), 'registry', 'geometry');
}

/** State/county geometry is national ("us"); place/tract is per-state. */
function fileKeyFor(level: GeoLevel, extentFips: string): string {
	return level === 'state' || level === 'county' ? 'us' : extentFips.slice(0, 2);
}

const cache = new Map<string, GeoFeature[]>();

function loadFile(level: GeoLevel, fileKey: string): GeoFeature[] {
	const cacheId = `${level}/${fileKey}`;
	const cached = cache.get(cacheId);
	if (cached) return cached;

	const file = join(geometryDir(), level, `${fileKey}.json`);
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		const hint = level === 'state' || level === 'county' ? level : `${level} ${fileKey}`;
		throw new GeometryError(
			`Geometry file not found: ${file}. Run \`bun scripts/fetch-geometry.ts ${hint}\` first.`
		);
	}

	const topo = JSON.parse(raw) as Topology<{ geo: GeometryCollection<GeoProps> }>;
	const fc = feature(topo, topo.objects.geo);
	const features = (fc.type === 'FeatureCollection' ? fc.features : [fc]) as GeoFeature[];
	cache.set(cacheId, features);
	return features;
}

/**
 * Load the geometry features whose GEOID falls within `extentFips`. Pass `''`
 * for a national extent (e.g. all counties), a 2-digit state FIPS for a state,
 * or a 5-digit county FIPS for tracts within a county.
 */
export function loadGeometry(level: GeoLevel, extentFips: string): LoadedGeometry {
	const all = loadFile(level, fileKeyFor(level, extentFips));
	const features = all.filter((f) => String(f.id ?? f.properties.GEOID).startsWith(extentFips));
	const byGeoid = new Map(features.map((f) => [String(f.id ?? f.properties.GEOID), f]));
	return { features, byGeoid };
}
