<script lang="ts">
	import '@fontsource-variable/playfair-display';
	import '@fontsource-variable/source-serif-4';
	import '../app.css';
	import { ModeWatcher, toggleMode } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ChartLineIcon from '@lucide/svelte/icons/chart-line';
	import ChartAreaIcon from '@lucide/svelte/icons/chart-area';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import ChartScatterIcon from '@lucide/svelte/icons/chart-scatter';
	import MapIcon from '@lucide/svelte/icons/map';
	import { page } from '$app/state';
	import { onNavigate, invalidateAll, goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import type { ChartEvent, ChartKind } from '$lib/census/types.js';
	import type { LayoutData } from './$types.js';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	const activeId = $derived(page.url.pathname.match(/^\/charts\/(.+)$/)?.[1]);
	const activeChart = $derived(data.charts.find((c) => c.id === activeId));

	// The id of the chart currently being viewed, read live (not closed-over).
	function currentId() {
		return page.url.pathname.match(/^\/charts\/(.+)$/)?.[1];
	}

	// Live updates: subscribe to the SSE stream of chart file events.
	onMount(() => {
		const es = new EventSource('/api/charts/stream');

		es.addEventListener('add', (ev) => {
			const e = JSON.parse(ev.data) as ChartEvent;
			toast.success('New chart', { description: e.title });
			invalidateAll();
		});
		es.addEventListener('change', (ev) => {
			const e = JSON.parse(ev.data) as ChartEvent;
			if (e.id === currentId()) toast('Chart updated', { description: e.title });
			invalidateAll();
		});
		es.addEventListener('remove', (ev) => {
			const e = JSON.parse(ev.data) as ChartEvent;
			// If we're viewing the removed chart, leave before it 404s. Either way,
			// refresh the layout list so the sidebar drops the removed entry.
			if (e.id === currentId()) goto('/', { invalidateAll: true });
			else invalidateAll();
		});

		return () => es.close();
	});

	const kindIcon = {
		line: ChartLineIcon,
		area: ChartAreaIcon,
		bar: ChartColumnIcon,
		scatter: ChartScatterIcon,
		map: MapIcon
	} satisfies Record<ChartKind, unknown>;

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<ModeWatcher defaultMode="dark" />
<Toaster position="bottom-right" />

<Sidebar.Provider open={data.sidebarOpen}>
	<Sidebar.Root variant="inset" class="border-none">
		<Sidebar.Header class="px-3 py-4">
			<a href="/" class="font-heading text-xl font-semibold tracking-tight">Census</a>
			<p class="text-xs text-muted-foreground">
				Charts from <code class="font-mono">charts/</code>
			</p>
		</Sidebar.Header>
		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupLabel>Newest first</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each data.charts as chart (chart.id)}
							{@const Icon = kindIcon[chart.kind]}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={activeId === chart.id}>
									{#snippet child({ props })}
										<a href="/charts/{chart.id}" {...props}>
											<Icon />
											<span>{chart.title}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{:else}
							<p class="px-2 py-1.5 text-xs text-muted-foreground">No charts yet.</p>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		</Sidebar.Content>
		<Sidebar.Footer>
			<Button variant="ghost" size="sm" class="justify-start gap-2" onclick={toggleMode}>
				<SunIcon class="size-4 dark:hidden" />
				<MoonIcon class="hidden size-4 dark:block" />
				<span>Toggle theme</span>
			</Button>
		</Sidebar.Footer>
	</Sidebar.Root>

	<Sidebar.Inset class="border">
		<header class="flex h-12 items-center gap-2 px-4 sm:px-8">
			<Sidebar.Trigger />
			<Separator orientation="vertical" class="mr-1 data-[orientation=vertical]:h-4" />
			<nav class="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
				<a href="/" class="text-muted-foreground transition-colors hover:text-foreground">Charts</a>
				{#if activeChart}
					<ChevronRightIcon class="size-3.5 text-muted-foreground/60" />
					<span class="font-medium text-foreground">{activeChart.title}</span>
				{/if}
			</nav>
		</header>
		<main class="flex-1 px-4 pb-10 [view-transition-name:page] sm:px-8">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
