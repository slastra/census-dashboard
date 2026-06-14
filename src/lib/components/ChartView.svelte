<script lang="ts">
	import { LineChart, BarChart, AreaChart, ScatterChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { ChartConfig } from '$lib/components/ui/chart/index.js';
	import type { ChartPayload } from '$lib/census/compile.js';

	let { payload }: { payload: ChartPayload } = $props();

	const uniqueYears = $derived([...new Set(payload.data.map((r) => r.year))]);
	// A single-year bar is a ranking across places, not a time series — render it
	// as a sorted horizontal bar (one per place) instead of grouped bars at one tick.
	const isRanking = $derived(payload.kind === 'bar' && uniqueYears.length === 1);

	const subtitle = $derived.by(() => {
		const base = payload.options.y_label ?? payload.metric.label;
		const parts = [base];
		if (isRanking) parts.push(`${uniqueYears[0]}`, `${payload.series.length} places`);
		else if (payload.series.length > 4) parts.push(`${payload.series.length} places`);
		else {
			const names = payload.series.map((s) => s.label).join(' vs ');
			if (names) parts.push(names);
		}
		return parts.join(' · ');
	});

	type WideRow = { year: number } & Record<string, number | null>;

	// Pivot tidy long-format rows into wide rows (one per year) for LayerChart.
	const data = $derived.by<WideRow[]>(() => {
		const byYear = new Map<number, WideRow>();
		for (const row of payload.data) {
			const r = byYear.get(row.year) ?? ({ year: row.year } as WideRow);
			r[row.series] = row.value;
			byYear.set(row.year, r);
		}
		return [...byYear.values()].sort((a, b) => a.year - b.year);
	});

	// LayerChart series: key + accessor + on-palette color.
	const series = $derived(
		payload.series.map((s) => ({ key: s.key, label: s.label, color: s.color, value: s.key }))
	);

	// shadcn chart config drives tooltip/legend labels + swatch colors.
	const config = $derived(
		Object.fromEntries(
			payload.series.map((s) => [s.key, { label: s.label, color: s.color }])
		) satisfies ChartConfig
	);

	const yFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
	const chartProps = $derived({
		data,
		x: 'year',
		series,
		axis: true,
		grid: true,
		legend: payload.series.length > 1,
		props: {
			xAxis: { format: (v: number) => String(Math.round(v)) },
			yAxis: { format: (v: number) => yFmt.format(v) },
			spline: { class: 'stroke-2' },
			// LayerChart bars default to a 1px black stroke; match it to the card
			// so it's a subtle separation instead of a harsh outline (esp. light mode).
			bars: { stroke: 'var(--card)', strokeWidth: 1 }
		}
	});

	// Ranking mode: one bar per place, sorted high→low (horizontal so labels fit).
	const rankData = $derived(
		payload.series
			.map((s) => ({
				name: s.label,
				value: payload.data.find((r) => r.series === s.key)?.value ?? null
			}))
			.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
	);
	// Reserve enough left margin for the longest place label.
	const rankPadLeft = $derived(
		Math.min(180, Math.max(72, Math.max(0, ...rankData.map((d) => d.name.length)) * 7.5 + 16))
	);
	const rankProps = $derived({
		data: rankData,
		x: 'value',
		y: 'name',
		orientation: 'horizontal' as const,
		padding: { left: rankPadLeft, bottom: 28 },
		series: [
			{ key: 'value', label: payload.metric.label, color: 'var(--chart-1)', value: 'value' }
		],
		axis: true,
		grid: true,
		legend: false,
		props: {
			xAxis: { format: (v: number) => yFmt.format(v) },
			bars: { radius: 3, stroke: 'var(--card)', strokeWidth: 1 }
		}
	});
	const containerHeight = $derived(isRanking ? Math.max(380, rankData.length * 30) : 420);
</script>

<Card.Root class="bg-card/60 backdrop-blur-xl">
	<Card.Header>
		<Card.Title class="text-base font-medium">{payload.metric.label}</Card.Title>
		<Card.Description>{subtitle}</Card.Description>
	</Card.Header>
	<Card.Content>
		<Chart.Container {config} class="w-full" style="height: {containerHeight}px">
			{#if data.length === 0}
				<div class="flex h-full items-center justify-center text-muted-foreground">No data.</div>
			{:else if isRanking}
				<BarChart {...rankProps} />
			{:else if payload.kind === 'bar'}
				<BarChart {...chartProps} seriesLayout="group" />
			{:else if payload.kind === 'area'}
				<AreaChart {...chartProps} />
			{:else if payload.kind === 'scatter'}
				<ScatterChart {...chartProps} />
			{:else}
				<LineChart {...chartProps} />
			{/if}
		</Chart.Container>
	</Card.Content>
</Card.Root>
