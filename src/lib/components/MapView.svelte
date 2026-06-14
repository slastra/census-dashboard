<script lang="ts">
	import { Chart, Layer, GeoPath } from 'layerchart';
	import { geoAlbersUsa, geoMercator } from 'd3-geo';
	import { scaleQuantize } from 'd3-scale';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { Feature, Geometry } from 'geojson';
	import type { MapPayload, MapFeatureProps } from '$lib/census/compile.js';

	let { payload }: { payload: MapPayload } = $props();

	type MapFeature = Feature<Geometry, MapFeatureProps>;

	const animated = $derived(payload.years.length > 1);
	const yearRange = $derived(
		animated ? `${payload.years[0]}–${payload.years.at(-1)}` : `${payload.years[0]}`
	);

	// Projection: geoAlbersUsa handles AK/HI insets for national maps; a fitted
	// Mercator works for a single state or county.
	const projection = $derived(payload.projection === 'albersUsa' ? geoAlbersUsa : geoMercator);

	// --- Animation: step through one frame per year ----------------------------
	let index = $state(0);
	let playing = $state(false);

	// (Re)initialize when the chart changes (e.g. navigating between maps).
	$effect(() => {
		payload.id; // track
		index = 0;
		playing = payload.years.length > 1;
	});

	const safeIndex = $derived(Math.min(index, payload.years.length - 1));
	const currentYear = $derived(payload.years[safeIndex]);
	const currentFrame = $derived(payload.frames[currentYear] ?? {});

	// Auto-advance while playing; the CSS fill transition crossfades each step.
	$effect(() => {
		if (!playing || payload.years.length < 2) return;
		const id = setInterval(() => {
			index = (index + 1) % payload.years.length;
		}, 950);
		return () => clearInterval(id);
	});

	// --- Color scale (fixed domain across all years) ---------------------------
	const BUCKETS = 5;
	const bucket = $derived(scaleQuantize<number>().domain(payload.domain).range([0, 1, 2, 3, 4]));
	const pctFor = (b: number) => 34 + b * 16; // ~34%..98% rose mixed into the card

	function fillFor(value: number | null | undefined): string {
		if (value == null) return 'var(--muted)';
		return `color-mix(in oklch, var(--chart-1) ${pctFor(bucket(value))}%, var(--card))`;
	}

	const isMoney = $derived(/income|rent|value/.test(payload.metric.alias));
	const fmt = new Intl.NumberFormat('en-US', {
		notation: 'compact',
		maximumFractionDigits: 1,
		style: 'currency',
		currency: 'USD'
	});
	const fmtPlain = new Intl.NumberFormat('en-US', {
		notation: 'compact',
		maximumFractionDigits: 1
	});
	const format = (v: number) => (isMoney ? fmt.format(v) : fmtPlain.format(v));

	const legend = $derived(
		Array.from({ length: BUCKETS }, (_, i) => {
			const [lo] = bucket.invertExtent(i);
			return { pct: pctFor(i), lo };
		})
	);

	// --- Hover tooltip ---------------------------------------------------------
	let hovered = $state<MapFeature | null>(null);
	let pos = $state({ x: 0, y: 0 });
	let mapEl = $state<HTMLDivElement>();
	let mapWidth = $state(0);

	// The tooltip is positioned absolutely inside the map container — `position:
	// fixed` can't be used because the card's backdrop-blur ancestor becomes the
	// containing block for it.
	function track(e: PointerEvent) {
		if (!mapEl) return;
		const r = mapEl.getBoundingClientRect();
		pos = { x: e.clientX - r.left, y: e.clientY - r.top };
		mapWidth = r.width;
	}
	const flipX = $derived(pos.x > mapWidth / 2);
	const hoveredValue = $derived(hovered ? currentFrame[hovered.properties.GEOID] : null);
</script>

<Card.Root class="bg-card/60 backdrop-blur-xl">
	<Card.Header>
		<Card.Title class="text-base font-medium">{payload.metric.label}</Card.Title>
		<Card.Description>{payload.level} · {payload.within} · {yearRange}</Card.Description>
	</Card.Header>

	<Card.Content>
		<div bind:this={mapEl} class="relative h-[480px] w-full">
			<Chart geo={{ projection, fitGeojson: payload.features }} height={480}>
				<Layer type="svg">
					{#each payload.features.features as f (f.properties.GEOID)}
						<GeoPath
							geojson={f}
							fill={fillFor(currentFrame[f.properties.GEOID])}
							class="cursor-pointer stroke-[var(--background)] [stroke-width:0.4] [transition:fill_700ms_linear,opacity_150ms_ease] hover:opacity-70"
							onpointerenter={() => (hovered = f as MapFeature)}
							onpointerleave={() => (hovered = null)}
							onpointermove={track}
						/>
					{/each}
				</Layer>
			</Chart>

			{#if hovered}
				<div
					class="pointer-events-none absolute z-50 rounded-md border border-border/60 bg-popover/90 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur-sm"
					style="left: {pos.x}px; top: {pos.y}px; transform: translate({flipX
						? 'calc(-100% - 12px)'
						: '12px'}, 12px)"
				>
					<div class="font-medium text-popover-foreground">{hovered.properties.NAME}</div>
					<div class="text-muted-foreground">
						{hoveredValue != null ? format(hoveredValue) : 'No data'}
						{#if animated}<span class="opacity-60"> · {currentYear}</span>{/if}
					</div>
				</div>
			{/if}
		</div>
	</Card.Content>

	<Card.Footer class="flex-col items-stretch gap-3">
		{#if animated}
			<!-- Playback controls -->
			<div class="flex items-center gap-3">
				<button
					type="button"
					onclick={() => (playing = !playing)}
					class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90"
					aria-label={playing ? 'Pause' : 'Play'}
				>
					{#if playing}<PauseIcon class="size-4" />{:else}<PlayIcon
							class="size-4 translate-x-px"
						/>{/if}
				</button>
				<input
					type="range"
					min="0"
					max={payload.years.length - 1}
					step="1"
					bind:value={index}
					oninput={() => (playing = false)}
					class="h-1.5 flex-1 cursor-pointer accent-[var(--chart-1)]"
					aria-label="Year"
				/>
				<span class="font-heading w-12 text-right text-lg tabular-nums">{currentYear}</span>
			</div>
		{/if}

		<!-- Legend -->
		<div
			class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
		>
			<span class="flex items-center gap-1.5">
				{#each legend as b (b.pct)}
					<span class="flex items-center gap-1">
						<span
							class="size-3 rounded-[2px] border border-border/40"
							style="background: color-mix(in oklch, var(--chart-1) {b.pct}%, var(--card))"
						></span>
						<span>{format(b.lo)}</span>
					</span>
				{/each}
			</span>
			<span class="flex items-center gap-1">
				<span class="size-3 rounded-[2px] border border-border/40 bg-muted"></span>
				<span>no data</span>
			</span>
		</div>
	</Card.Footer>
</Card.Root>
