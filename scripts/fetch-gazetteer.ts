#!/usr/bin/env bun
/**
 * Download the Census Gazetteer national flat files for Places and Counties
 * into registry/gazetteer/. These are public, immutable flat files used for
 * fully offline geography resolution (no API calls at request time).
 *
 * Usage: bun scripts/fetch-gazetteer.ts [year]   (default year below)
 */

import { mkdir, writeFile, rm, readdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const DEFAULT_YEAR = 2023;
const BASE = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer';
const OUT_DIR = join(import.meta.dirname, '..', 'registry', 'gazetteer');

const targets = [
	{ kind: 'place', file: (y: number) => `${y}_Gaz_place_national.zip`, out: 'places.txt' },
	{ kind: 'county', file: (y: number) => `${y}_Gaz_counties_national.zip`, out: 'counties.txt' }
] as const;

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: 'inherit' });
		p.on('error', reject);
		p.on('close', (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))
		);
	});
}

async function main() {
	const year = Number(process.argv[2]) || DEFAULT_YEAR;
	await mkdir(OUT_DIR, { recursive: true });
	const tmp = join(OUT_DIR, '.tmp');
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });

	for (const t of targets) {
		const url = `${BASE}/${year}_Gazetteer/${t.file(year)}`;
		process.stdout.write(`↓ ${t.kind}: ${url}\n`);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`failed to download ${url}: HTTP ${res.status}`);
		const zipPath = join(tmp, t.file(year));
		await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
		await run('unzip', ['-o', '-d', tmp, zipPath]);

		// The extracted file is named like "<year>_Gaz_place_national.txt".
		const extracted = (await readdir(tmp)).find((f) => f.endsWith('.txt'));
		if (!extracted) throw new Error(`no .txt found after unzipping ${t.file(year)}`);
		await rename(join(tmp, extracted), join(OUT_DIR, t.out));
		console.log(`  → registry/gazetteer/${t.out}`);
	}

	await rm(tmp, { recursive: true, force: true });
	await writeFile(
		join(OUT_DIR, 'VINTAGE.txt'),
		`Census Gazetteer ${year} national files (places, counties).\n` +
			`Source: ${BASE}/${year}_Gazetteer/\n`
	);
	console.log(`\n✓ Gazetteer ${year} ready in registry/gazetteer/`);
}

main().catch((err) => {
	console.error(`✗ ${err.message}`);
	process.exit(1);
});
