import { subscribe } from '$lib/server/watcher.js';
import type { RequestHandler } from './$types.js';

// GET /api/charts/stream — Server-Sent Events for chart add/change/remove.
export const GET: RequestHandler = () => {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;
	let keepAlive: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			send('hello', { ok: true });
			unsubscribe = subscribe((e) => send(e.type, e));

			// Comment ping keeps proxies/browsers from closing an idle connection.
			keepAlive = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 25_000);
		},
		cancel() {
			unsubscribe?.();
			if (keepAlive) clearInterval(keepAlive);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
