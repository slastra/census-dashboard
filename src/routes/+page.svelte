<script lang="ts">
	// Only rendered when charts/ is empty — otherwise +page.server.ts redirects
	// to the newest chart.
</script>

<div
	class="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 text-center"
>
	<h1 class="font-heading text-4xl font-semibold tracking-tight">No charts yet</h1>
	<p class="text-muted-foreground">
		Drop a TOML file into <code class="font-mono text-primary">charts/</code> and it'll appear here —
		newest first, with a toast.
	</p>
	<p class="text-sm text-muted-foreground">
		Try <code class="font-mono">bun cli/census.ts new my-first-chart</code>.
	</p>
</div>
