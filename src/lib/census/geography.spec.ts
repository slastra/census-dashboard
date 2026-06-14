import { describe, it, expect } from 'vitest';
import { resolveGeography, parsePlaceString, GeographyError } from './geography.js';

describe('parsePlaceString', () => {
	it('splits name and state', () => {
		expect(parsePlaceString('Rogers, AR')).toEqual({ name: 'Rogers', state: 'AR' });
	});
	it('handles names with commas only at the state boundary', () => {
		expect(parsePlaceString('Winston-Salem, NC')).toEqual({ name: 'Winston-Salem', state: 'NC' });
	});
	it('rejects a missing state', () => {
		expect(() => parsePlaceString('Rogers')).toThrow(GeographyError);
	});
	it('rejects a non-two-letter state', () => {
		expect(() => parsePlaceString('Rogers, Arkansas')).toThrow(/two-letter state/);
	});
});

describe('resolveGeography — acceptance places', () => {
	it('resolves Rogers, AR to GEOID 0560410', () => {
		const g = resolveGeography('Rogers, AR');
		expect(g.geoid).toBe('0560410');
		expect(g.type).toBe('place');
		expect(g.stateFips).toBe('05');
		expect(g.placeFips).toBe('60410');
		expect(g.displayName).toBe('Rogers');
	});

	it('resolves Springdale, AR to GEOID 0566080', () => {
		const g = resolveGeography('Springdale, AR');
		expect(g.geoid).toBe('0566080');
		expect(g.displayName).toBe('Springdale');
	});

	it('resolves a county by suffix', () => {
		const g = resolveGeography('Benton County, AR');
		expect(g.type).toBe('county');
		expect(g.geoid).toBe('05007');
		expect(g.stateFips).toBe('05');
		expect(g.countyFips).toBe('007');
	});
});

describe('resolveGeography — guardrails', () => {
	it('throws on a name not found in the state', () => {
		expect(() => resolveGeography('Nowheresville, AR')).toThrow(GeographyError);
	});

	it('throws with a candidate list on an ambiguous name', () => {
		// Unionville, PA: 3 CDPs + 1 borough all share the core name.
		expect.assertions(2);
		try {
			resolveGeography('Unionville, PA');
		} catch (err) {
			expect(err).toBeInstanceOf(GeographyError);
			expect((err as GeographyError).candidates.length).toBeGreaterThan(1);
		}
	});
});
