import { error } from '@sveltejs/kit';
import type { Payload } from '$lib/census/compile.js';
import type { PageLoad } from './$types.js';

export const load: PageLoad = async ({ params, fetch }) => {
	const res = await fetch(`/api/charts/${params.id}`);
	if (res.status === 404) error(404, `No chart "${params.id}"`);
	if (!res.ok) error(res.status, `Failed to load chart "${params.id}"`);
	const payload = (await res.json()) as Payload;
	return { payload };
};
