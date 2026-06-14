import { redirect } from '@sveltejs/kit';
import { newestChartId } from '$lib/server/charts.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	const id = await newestChartId();
	if (id) redirect(307, `/charts/${id}`);
	return {};
};
