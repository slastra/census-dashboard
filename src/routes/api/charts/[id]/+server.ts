import { json, error } from '@sveltejs/kit';
import { getChartPayload } from '$lib/server/charts.js';
import { CompileError } from '$lib/census/compile.js';
import type { RequestHandler } from './$types.js';

// GET /api/charts/[id] — the compiled chart payload.
export const GET: RequestHandler = async ({ params }) => {
	try {
		const payload = await getChartPayload(params.id);
		if (!payload) error(404, `No chart "${params.id}"`);
		return json(payload);
	} catch (err) {
		if (err instanceof CompileError) error(422, err.issues.join('; '));
		throw err;
	}
};
