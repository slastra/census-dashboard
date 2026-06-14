/**
 * Watch the charts/ directory and emit add/change/remove events.
 *
 * The watcher is a process-wide singleton stashed on globalThis so Vite's HMR
 * doesn't spawn duplicate watchers (which would double-fire SSE events in dev).
 * fs.watch on a flat directory is sufficient — no recursion needed.
 */

import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseChartSpec } from '$lib/census/schema.js';
import { chartsDir } from './charts.js';
import type { ChartEvent, ChartKind } from '$lib/census/types.js';

type Listener = (e: ChartEvent) => void;

interface WatcherState {
	fsWatcher: FSWatcher;
	listeners: Set<Listener>;
	/** filename -> last-known {id, title, kind}, so removes can be identified. */
	known: Map<string, { id: string; title: string; kind: ChartKind }>;
	debounce: Map<string, ReturnType<typeof setTimeout>>;
}

declare global {
	// eslint-disable-next-line no-var
	var __censusWatcher: WatcherState | undefined;
}

function isToml(name: string): boolean {
	return name.toLowerCase().endsWith('.toml');
}

async function readMeta(file: string) {
	const raw = await readFile(file, 'utf8');
	const spec = parseChartSpec(raw, { filename: file });
	return { id: spec.id, title: spec.title, kind: spec.kind };
}

function emit(state: WatcherState, e: ChartEvent) {
	for (const l of state.listeners) {
		try {
			l(e);
		} catch {
			// a broken listener must not break the others
		}
	}
}

async function handleChange(state: WatcherState, filename: string) {
	const file = join(chartsDir(), filename);

	if (!existsSync(file)) {
		const prev = state.known.get(filename);
		if (prev) {
			state.known.delete(filename);
			emit(state, { type: 'remove', id: prev.id, title: prev.title, kind: prev.kind });
		}
		return;
	}

	let meta;
	try {
		meta = await readMeta(file);
	} catch {
		// Invalid TOML mid-edit — ignore until it parses cleanly.
		return;
	}

	const prev = state.known.get(filename);
	state.known.set(filename, meta);
	emit(state, { type: prev ? 'change' : 'add', ...meta });
}

function init(): WatcherState {
	const dir = chartsDir();
	const state: WatcherState = {
		fsWatcher: watch(dir, { persistent: false }, (_event, filename) => {
			if (!filename || !isToml(filename)) return;
			// Debounce bursts (editors fire multiple events per save).
			const existing = state.debounce.get(filename);
			if (existing) clearTimeout(existing);
			state.debounce.set(
				filename,
				setTimeout(() => {
					state.debounce.delete(filename);
					void handleChange(state, filename);
				}, 120)
			);
		}),
		listeners: new Set(),
		known: new Map(),
		debounce: new Map()
	};

	// Seed known state with whatever is already present.
	void (async () => {
		try {
			for (const f of await readdir(dir)) {
				if (!isToml(f)) continue;
				try {
					state.known.set(f, await readMeta(join(dir, f)));
				} catch {
					// skip invalid
				}
			}
		} catch {
			// charts dir may not exist yet
		}
	})();

	return state;
}

function getWatcher(): WatcherState {
	if (!globalThis.__censusWatcher) globalThis.__censusWatcher = init();
	return globalThis.__censusWatcher;
}

/** Subscribe to chart file events. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
	const state = getWatcher();
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}
