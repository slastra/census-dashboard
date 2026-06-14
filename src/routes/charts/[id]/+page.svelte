<script lang="ts">
	import ChartView from '$lib/components/ChartView.svelte';
	import MapView from '$lib/components/MapView.svelte';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	const payload = $derived(data.payload);
</script>

<svelte:head><title>{payload.title} · Census</title></svelte:head>

<div class="space-y-6 pt-4">
	{#if payload.kind === 'map'}
		<MapView {payload} />
	{:else}
		<ChartView {payload} />
	{/if}

	{#if payload.warnings.length}
		<div class="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
			{#each payload.warnings as w}
				<p class="flex items-start gap-2 text-muted-foreground">
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-chart-4" />
					<span>{w}</span>
				</p>
			{/each}
		</div>
	{/if}
</div>
