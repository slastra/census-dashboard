import { describe, it, expect } from 'vitest';
import { parseChartSpec, ChartSpecError, slugFromFilename } from './schema.js';
import type { SeriesChartSpec, MapChartSpec } from './types.js';

/** Parse and narrow to a series spec (for tests that read series/years). */
const parseSeries = (toml: string, opts?: { filename?: string }) =>
	parseChartSpec(toml, opts) as SeriesChartSpec;

/** Parse and narrow to a map spec. */
const parseMap = (toml: string, opts?: { filename?: string }) =>
	parseChartSpec(toml, opts) as MapChartSpec;

const ROGERS = `
[chart]
id = "rogers-vs-springdale-population"
title = "Population: Rogers vs Springdale, AR"
kind = "line"
description = "Historical total population."

[query]
metric = "population"
dataset = "acs5"
years = "2010..2023"

[[series]]
place = "Rogers, AR"
label = "Rogers"

[[series]]
place = "Springdale, AR"

[options]
y_label = "Population"
show_margin_of_error = false
`;

describe('parseChartSpec — acceptance case', () => {
	it('parses the Rogers vs Springdale fixture', () => {
		const spec = parseSeries(ROGERS, { filename: 'rogers-vs-springdale-population.toml' });
		expect(spec.id).toBe('rogers-vs-springdale-population');
		expect(spec.kind).toBe('line');
		expect(spec.query.dataset).toBe('acs5');
		expect(spec.query.metric).toBe('population');
		expect(spec.series).toHaveLength(2);
		expect(spec.series[0]).toEqual({ place: 'Rogers, AR', label: 'Rogers' });
		expect(spec.series[1].label).toBeUndefined();
		expect(spec.options.show_margin_of_error).toBe(false);
	});

	it('normalizes a range string to a sorted int list', () => {
		const spec = parseSeries(ROGERS, { filename: 'x.toml' });
		expect(spec.query.years).toEqual([
			2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023
		]);
	});
});

describe('years normalization', () => {
	const withYears = (years: string) => `
[chart]
title = "t"
kind = "bar"
[query]
metric = "population"
dataset = "acs5"
years = ${years}
[[series]]
place = "Rogers, AR"
`;

	it('accepts an explicit array, sorted + de-duped', () => {
		const spec = parseSeries(withYears('[2020, 2010, 2015, 2010]'), { filename: 'x.toml' });
		expect(spec.query.years).toEqual([2010, 2015, 2020]);
	});

	it('rejects a malformed range', () => {
		expect(() => parseChartSpec(withYears('"2010-2023"'), { filename: 'x.toml' })).toThrow(
			ChartSpecError
		);
	});

	it('rejects a reversed range', () => {
		expect(() => parseChartSpec(withYears('"2023..2010"'), { filename: 'x.toml' })).toThrow(
			/start 2023 is after end 2010/
		);
	});
});

describe('hard rules — no codes', () => {
	const base = (metric: string, place: string) => `
[chart]
title = "t"
kind = "line"
[query]
metric = "${metric}"
dataset = "acs5"
years = "2010..2012"
[[series]]
place = "${place}"
`;

	it('rejects a Census variable code as metric', () => {
		expect(() => parseChartSpec(base('B01003_001E', 'Rogers, AR'), { filename: 'x.toml' })).toThrow(
			/looks like a Census variable code/
		);
	});

	it('rejects a FIPS code in place', () => {
		expect(() => parseChartSpec(base('population', '0560410'), { filename: 'x.toml' })).toThrow(
			/looks like a FIPS\/GEOID code/
		);
	});

	it('rejects a place without a state', () => {
		expect(() => parseChartSpec(base('population', 'Rogers'), { filename: 'x.toml' })).toThrow(
			/must be a "Name, ST" string/
		);
	});
});

describe('enums + required fields', () => {
	it('rejects an unknown kind', () => {
		const toml = `
[chart]
title = "t"
kind = "pie"
[query]
metric = "population"
dataset = "acs5"
years = "2010..2012"
[[series]]
place = "Rogers, AR"
`;
		expect(() => parseChartSpec(toml, { filename: 'x.toml' })).toThrow(/chart.kind must be one of/);
	});

	it('requires at least one series', () => {
		const toml = `
[chart]
title = "t"
kind = "line"
[query]
metric = "population"
dataset = "acs5"
years = "2010..2012"
`;
		expect(() => parseChartSpec(toml, { filename: 'x.toml' })).toThrow(ChartSpecError);
	});
});

describe('id defaulting', () => {
	it('defaults id from the filename slug', () => {
		const toml = `
[chart]
title = "t"
kind = "line"
[query]
metric = "population"
dataset = "acs5"
years = "2010..2012"
[[series]]
place = "Rogers, AR"
`;
		const spec = parseChartSpec(toml, { filename: '/charts/My Cool Chart.toml' });
		expect(spec.id).toBe('my-cool-chart');
	});

	it('rejects a non-slug explicit id', () => {
		const toml = `
[chart]
id = "Not A Slug"
title = "t"
kind = "line"
[query]
metric = "population"
dataset = "acs5"
years = "2010..2012"
[[series]]
place = "Rogers, AR"
`;
		expect(() => parseChartSpec(toml, { filename: 'x.toml' })).toThrow(/must be a slug/);
	});
});

describe('map specs', () => {
	const map = (body: string) => `
[chart]
title = "m"
kind = "map"
[query]
metric = "median_home_value"
dataset = "acs5"
${body}
`;

	it('accepts a static map (single year)', () => {
		const spec = parseMap(map('year = 2023\n[map]\nlevel = "county"\nwithin = "AR"'), {
			filename: 'x.toml'
		});
		expect(spec.kind).toBe('map');
		expect(spec.query.years).toEqual([2023]);
		expect(spec.map).toEqual({ level: 'county', within: 'AR' });
	});

	it('accepts an animated map (year range → frames)', () => {
		const spec = parseMap(map('years = "2015..2023"\n[map]\nlevel = "county"\nwithin = "AR"'), {
			filename: 'x.toml'
		});
		expect(spec.query.years).toHaveLength(9);
		expect(spec.query.years[0]).toBe(2015);
	});

	it('rejects [[series]] in a map', () => {
		const toml = map(
			'year = 2023\n[map]\nlevel = "state"\nwithin = "US"\n[[series]]\nplace = "Rogers, AR"'
		);
		expect(() => parseChartSpec(toml, { filename: 'x.toml' })).toThrow(
			/does not use \[\[series\]\]/
		);
	});

	it('enforces the level × within matrix', () => {
		const bad = map('year = 2023\n[map]\nlevel = "place"\nwithin = "US"');
		expect(() => parseChartSpec(bad, { filename: 'x.toml' })).toThrow(/level "place" requires/);
		const bad2 = map('year = 2023\n[map]\nlevel = "state"\nwithin = "AR"');
		expect(() => parseChartSpec(bad2, { filename: 'x.toml' })).toThrow(/level "state" requires/);
	});

	it('rejects a FIPS code in within', () => {
		const bad = map('year = 2023\n[map]\nlevel = "county"\nwithin = "05007"');
		expect(() => parseChartSpec(bad, { filename: 'x.toml' })).toThrow(/looks like a FIPS code/);
	});
});

describe('slugFromFilename', () => {
	it('strips path + extension and slugifies', () => {
		expect(slugFromFilename('/a/b/Rogers vs Springdale.toml')).toBe('rogers-vs-springdale');
	});
});
