import { describe, it, expect } from 'vitest';
import { resolveSpec } from './compile.js';
import { coerceValue, moeVariable } from './client.js';
import type { SeriesChartSpec, SeriesQuery } from './types.js';

function spec(partial: Partial<SeriesQuery> = {}): SeriesChartSpec {
	return {
		id: 'x',
		title: 'X',
		kind: 'line',
		query: { metric: 'population', dataset: 'acs5', years: [2018, 2019, 2020], ...partial },
		series: [{ place: 'Rogers, AR' }],
		options: { show_margin_of_error: false }
	};
}

describe('coerceValue', () => {
	it('parses numeric strings', () => {
		expect(coerceValue('53207')).toBe(53207);
	});
	it('maps Census sentinels to null', () => {
		expect(coerceValue('-666666666')).toBeNull();
		expect(coerceValue('-999999999')).toBeNull();
	});
	it('maps empty/undefined to null', () => {
		expect(coerceValue('')).toBeNull();
		expect(coerceValue(undefined)).toBeNull();
	});
});

describe('moeVariable', () => {
	it('swaps the trailing E for M', () => {
		expect(moeVariable('B01003_001E')).toBe('B01003_001M');
	});
});

describe('resolveSpec — coverage rules', () => {
	it('resolves a valid acs5 spec with no errors', () => {
		const r = resolveSpec(spec());
		expect(r.errors).toEqual([]);
		expect(r.metric?.code).toBe('B01003_001E');
		expect(r.geos).toHaveLength(1);
		expect(r.years).toEqual([2018, 2019, 2020]);
	});

	it('drops 2020 from an acs1 range and warns', () => {
		const r = resolveSpec(spec({ dataset: 'acs1' }));
		expect(r.years).toEqual([2018, 2019]);
		expect(r.warnings.some((w) => w.includes('2020'))).toBe(true);
	});

	it('rejects decennial as unsupported in v1', () => {
		const r = resolveSpec(spec({ dataset: 'decennial' }));
		expect(r.errors.some((e) => e.includes('not supported'))).toBe(true);
	});

	it('reports an unknown metric alias', () => {
		const r = resolveSpec(spec({ metric: 'unobtanium' }));
		expect(r.errors.some((e) => e.includes('unknown metric alias'))).toBe(true);
	});
});
