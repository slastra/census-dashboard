/**
 * Bridge the Census API key from SvelteKit's env loader into process.env, so
 * the shared census client (also used by the standalone CLI) can read it the
 * same way in both contexts. SvelteKit's $env/dynamic/private reliably loads
 * .env in dev and prod; plain process.env does not in Vite's SSR runtime.
 */

import { env } from '$env/dynamic/private';

if (!process.env.CENSUS_DATA_API_KEY && env.CENSUS_DATA_API_KEY) {
	process.env.CENSUS_DATA_API_KEY = env.CENSUS_DATA_API_KEY;
}
