/**
 * Metric registry: resolve a friendly alias (e.g. "population") to the Census
 * variable code for a given dataset. Codes differ by dataset and, for
 * decennial, by vintage — so resolution is dataset- (and year-) aware.
 *
 * The registry is the system's compounding asset; an author never sees a
 * variable code. Resolution failures list which datasets an alias supports so
 * the author can correct course.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { type Dataset, SUPPORTED_DATASETS } from './types.js';

export class RegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RegistryError';
	}
}

interface MetricEntry {
	label?: string;
	acs5?: string;
	acs1?: string;
	decennial_2020?: string;
	decennial_2010?: string;
	decennial_2000?: string;
}

export interface MetricInfo {
	alias: string;
	label: string;
	/** Human-readable list of supported datasets, e.g. ["acs5", "acs1", "decennial 2020"]. */
	datasets: string[];
}

function registryPath(): string {
	return process.env.METRICS_REGISTRY || join(process.cwd(), 'registry', 'metrics.toml');
}

let cached: Record<string, MetricEntry> | null = null;

function load(): Record<string, MetricEntry> {
	if (cached) return cached;
	let text: string;
	try {
		text = readFileSync(registryPath(), 'utf8');
	} catch {
		throw new RegistryError(`metric registry not found at ${registryPath()}`);
	}
	cached = parseToml(text) as Record<string, MetricEntry>;
	return cached;
}

/** Reset the in-memory cache (used after the registry file changes). */
export function clearRegistryCache(): void {
	cached = null;
}

const DATASET_KEYS: { key: keyof MetricEntry; display: string }[] = [
	{ key: 'acs5', display: 'acs5' },
	{ key: 'acs1', display: 'acs1' },
	{ key: 'decennial_2020', display: 'decennial 2020' },
	{ key: 'decennial_2010', display: 'decennial 2010' },
	{ key: 'decennial_2000', display: 'decennial 2000' }
];

function supportedDatasets(entry: MetricEntry): string[] {
	return DATASET_KEYS.filter(({ key }) => typeof entry[key] === 'string').map((d) => d.display);
}

/** True if a dataset is wired up end-to-end in v1 (acs5/acs1; decennial deferred). */
export function isDatasetSupported(dataset: Dataset): boolean {
	return (SUPPORTED_DATASETS as readonly Dataset[]).includes(dataset);
}

/** List all aliases with their label and supported datasets, sorted by alias. */
export function listMetrics(): MetricInfo[] {
	const reg = load();
	return Object.entries(reg)
		.map(([alias, entry]) => ({
			alias,
			label: entry.label ?? alias,
			datasets: supportedDatasets(entry)
		}))
		.sort((a, b) => a.alias.localeCompare(b.alias));
}

export interface ResolvedMetric {
	alias: string;
	label: string;
	dataset: Dataset;
	year?: number;
	/** The Census variable code, e.g. "B01003_001E". */
	code: string;
}

/**
 * Resolve an alias + dataset to a variable code. For decennial, a `year`
 * (vintage) is required because codes differ per vintage. Throws RegistryError
 * with the supported-dataset list on any miss.
 */
export function resolveMetricCode(alias: string, dataset: Dataset, year?: number): ResolvedMetric {
	const reg = load();
	const entry = reg[alias];
	if (!entry) {
		const known = Object.keys(reg).sort().join(', ');
		throw new RegistryError(
			`unknown metric alias "${alias}". Known aliases: ${known}. ` +
				`Run \`census metrics\` for details, or add it to registry/metrics.toml.`
		);
	}

	let key: keyof MetricEntry;
	if (dataset === 'decennial') {
		if (year === undefined) {
			throw new RegistryError(`decennial metric "${alias}" requires a vintage year to resolve`);
		}
		key = `decennial_${year}` as keyof MetricEntry;
	} else {
		key = dataset;
	}

	const code = entry[key];
	if (typeof code !== 'string') {
		const supported = supportedDatasets(entry);
		const what = dataset === 'decennial' ? `decennial ${year}` : dataset;
		throw new RegistryError(
			`metric "${alias}" has no code for ${what}. It supports: ${supported.join(', ') || '(none)'}.`
		);
	}

	return { alias, label: entry.label ?? alias, dataset, year, code };
}
