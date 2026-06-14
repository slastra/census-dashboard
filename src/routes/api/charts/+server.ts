import { json } from '@sveltejs/kit';
import { listCharts } from '$lib/server/charts.js';
import type { RequestHandler } from './$types.js';

// GET /api/charts — chart metadata, already sorted newest-first.
export const GET: RequestHandler = async () => {
	return json(await listCharts());
};
