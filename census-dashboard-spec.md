# Census Chart Dashboard — Build Spec

## Goal

A SvelteKit dashboard that renders charts of U.S. Census data. Each chart is defined by a single TOML file in a watched directory. Adding a TOML file makes a new chart appear in the app: a toast announces it, and it shows at the top of a newest-first menu. The author of these TOML files is usually an AI coding agent, so the spec format must stay small, declarative, and machine-validatable, with all Census ugliness (FIPS codes, variable codes, per-year fetches) pushed into the framework.

The canonical acceptance case: a TOML file describing historical population of Rogers, AR versus Springdale, AR renders as a line chart, with neither FIPS codes nor variable codes appearing anywhere in the TOML.

## Locked Stack Decisions

Do not deviate from these without flagging.

- Runtime and package manager: Bun
- Framework: SvelteKit with Svelte 5 (runes)
- UI: shadcn-svelte (including its chart components, which wrap LayerChart)
- Charting: LayerChart
- TOML parsing: `smol-toml`
- Schema validation: `zod`
- Toasts: `svelte-sonner` (via the shadcn-svelte sonner component)
- File watching: Bun `fs.watch` (or `chokidar` if recursive reliability is needed) on the server, surfaced to the client over SSE
- Cache store: filesystem JSON under `.cache/census/` (Census vintage data is immutable, so cache entries never expire)

## Repository Layout

```
charts/                      # watched directory of TOML chart specs (the content)
  rogers-vs-springdale-population.toml
registry/
  metrics.toml               # curated alias -> variable-code mappings
  gazetteer/                 # bundled Census Gazetteer flat files for offline geo resolution
src/
  lib/
    census/
      schema.ts              # zod schema for a ChartSpec + parse()
      registry.ts            # metric alias resolution
      geography.ts           # place/county name -> FIPS via gazetteer, with ambiguity detection
      client.ts              # Census API fetch + filesystem cache
      compile.ts             # ChartSpec -> resolved tidy dataset -> LayerChart props
      types.ts
    server/
      watcher.ts             # watches charts/, emits events
  routes/
    +layout.svelte           # sidebar menu (newest-first) + toast host
    charts/[id]/+page.ts     # loads compiled chart payload
    charts/[id]/+page.svelte # renders the chart via LayerChart
    api/charts/+server.ts            # GET list of chart metadata, newest-first
    api/charts/[id]/+server.ts       # GET compiled chart payload
    api/charts/stream/+server.ts     # SSE stream of add/change/remove events
cli/
  census.ts                  # validate | resolve | metrics | build | new | screenshot
```

## TOML Chart Spec

This is the only artifact the agent authors. Keep the surface small.

```toml
[chart]
# id is optional; defaults to the filename slug
id = "rogers-vs-springdale-population"
title = "Population: Rogers vs Springdale, AR"
kind = "line"                 # line | bar | area | scatter
description = "Historical total population, ACS 5-year estimates."

[query]
metric = "population"         # alias resolved via registry/metrics.toml
dataset = "acs5"              # acs5 | acs1 | decennial
years = "2010..2023"          # range "a..b" OR explicit list [2010, 2015, 2020]

[[series]]
place = "Rogers, AR"          # friendly geography string, resolved offline
label = "Rogers"             # optional display override

[[series]]
place = "Springdale, AR"

[options]                     # optional, all fields have defaults
y_label = "Population"
show_margin_of_error = false  # if true and dataset is ACS, render MOE band
```

Hard rules for the schema (enforce in `schema.ts`):

- No FIPS codes or variable codes are ever valid in the TOML. Only friendly aliases and place names. If a numeric-looking code appears where an alias belongs, fail validation with a clear message.
- `kind` is a closed enum. Unknown values fail.
- `years` accepts either a `"a..b"` range string or an array of integers. Normalize both to a sorted integer list.
- Every `[[series]]` needs a `place`. `label` is optional and defaults to the resolved geography name.
- `id` must be a slug (lowercase, hyphens). Default to the filename slug if omitted.

## Metric Registry

A curated mapping so the agent never touches variable codes. Variable codes differ by dataset and by decennial vintage, so the registry is keyed per dataset.

```toml
# registry/metrics.toml
[population]
label = "Total Population"
acs5 = "B01003_001E"
acs1 = "B01003_001E"
decennial_2020 = "P1_001N"
decennial_2010 = "P001001"

[median_household_income]
label = "Median Household Income"
acs5 = "B19013_001E"
acs1 = "B19013_001E"
# not available in decennial
```

Registry resolution rules:

- An alias must declare a code for the requested dataset (and for decennial, the requested vintage), or resolution fails with a message listing which datasets the alias supports.
- The CLI `census metrics` lists all aliases and their supported datasets so the agent can ground itself instead of guessing.
- The agent is allowed to append new aliases to this file as it learns them. Treat the registry as the system's compounding asset.

## Geography Resolution

Resolve friendly strings to Census FIPS offline and deterministically.

- Bundle the Census Gazetteer national flat files for Places and Counties into `registry/gazetteer/`. Provide a setup script that downloads them from the Census Gazetteer endpoint (these are public flat files).
- `geography.ts` parses `"Rogers, AR"` into a name plus state, then looks up the GEOID (state FIPS + place FIPS) from the gazetteer.
- Geography type detection: a name ending in "County" resolves against the county file; otherwise resolve against the places file. Allow an optional explicit hint later if needed, but keep the default inference for now.
- Ambiguity is a first-class error. If a name matches more than one row (or zero), fail validation and list the candidates with their GEOIDs. This is the single most important guardrail for agent reliability, so make the error message actionable.
- `census resolve "Rogers, AR"` prints the resolved GEOID and full gazetteer row, as a disambiguation aid for the agent.

## Data Pipeline (the compiler)

`compile.ts` turns a validated ChartSpec into render-ready props. This is the highest-risk seam, so keep the stages explicit and individually testable.

1. Parse: TOML -> validated ChartSpec (via `schema.ts`).
2. Resolve: metric alias -> variable code for the chosen dataset; each series place -> GEOID; years -> integer list.
3. Fetch (cached): for each year, issue one Census API call that batches all series geographies. Years require separate calls per vintage; geographies can be batched within a year using a comma-separated `for` clause. Cache each response by `hash(dataset, year, variable, sorted_geoids)`.
4. Normalize: assemble a tidy long-format dataset, one row per `{ seriesLabel, year, value, moe? }`. Coerce Census string values to numbers. Treat Census sentinel negatives (e.g. -666666666) as null.
5. Map to LayerChart: emit the data array plus the series/axis config that the shadcn-svelte chart component consumes. Pick the LayerChart mark from `chart.kind` (line -> line/spline, bar -> bars, area -> area, scatter -> points).

Emit the normalized tidy dataset alongside the chart payload so it can be inspected without re-rendering (see CLI `build`).

## Census API Specifics

- Base URL: `https://api.census.gov/data`
- ACS 5-year example: `GET /data/{year}/acs/acs5?get=NAME,{var}&for=place:{p1},{p2}&in=state:{ss}&key={KEY}`
- Responses are JSON arrays where row 0 is the header. Convert to objects before normalizing.
- API key: read from `CENSUS_API_KEY` env. Requests work without a key at low volume, but require it in any deployed path.
- Dataset coverage and year rules (encode these as validation warnings or errors):
  - ACS 5-year: annual, ~2009 to latest release, published for all geographies including small ones. Safe default for small places.
  - ACS 1-year: ~2005 to latest, published only for geographies with population at or above 65,000. Standard 2020 ACS 1-year estimates were not released, so exclude 2020 from any acs1 range and warn.
  - Decennial: 2000, 2010, 2020 only. Variable codes differ by vintage, which is why the registry keys decennial per year.
- Margin of error: ACS estimate variables end in `E`; the matching MOE variable ends in `M`. When `show_margin_of_error = true`, fetch the `M` variable too and carry it through to the tidy data for banding.

For the Rogers vs Springdale acceptance case, prefer `dataset = "acs5"` because it gives a clean annual series for both places without the 65,000 threshold issue.

## Frontend Behavior

Watched directory and live updates:

- `watcher.ts` watches `charts/` for add, change, and remove.
- `api/charts/stream` is an SSE endpoint that forwards those events to the client.
- On `add`: the client shows a toast ("New chart: {title}") and refreshes the menu. On `change`: if the changed chart is active, recompile and re-render. On `remove`: drop it from the menu.

Menu and selection:

- The sidebar lists all charts sorted newest-first. "Newest" is the file mtime by default; allow an optional `created` field in `[chart]` to override.
- Selecting an item navigates to `/charts/{id}` and renders that chart in the main panel.
- The index route redirects to the newest chart.
- `api/charts` returns chart metadata (id, title, kind, mtime) already sorted newest-first; the client does not re-sort.

Rendering:

- `/charts/[id]/+page.ts` fetches the compiled payload from `api/charts/[id]`.
- `/charts/[id]/+page.svelte` renders it with the shadcn-svelte chart component on top of LayerChart, choosing the mark from `chart.kind`.

## CLI (agent ergonomics)

`bun cli/census.ts <command>`. These exist to give the agent a tight write -> validate -> build loop with structured feedback.

- `validate <file>`: parse, resolve aliases and geographies, check dataset/year coverage. Print actionable errors. Exit nonzero on failure.
- `resolve "<place>"`: print the resolved GEOID and gazetteer row. Ambiguity prints all candidates.
- `metrics`: list registry aliases and which datasets each supports.
- `build <file>`: run the full pipeline and write the resolved tidy dataset to `.cache/charts/{id}.json` so the numbers can be sanity-checked without rendering.
- `new <slug>`: scaffold a valid skeleton TOML in `charts/`.
- `screenshot <file>` (optional, last): headless-render the chart to a PNG for visual verification.

## Edge Cases To Handle

- Geography name not found or ambiguous: fail with candidate list.
- Metric alias missing for the requested dataset or decennial vintage: fail and list supported datasets.
- A year with no data for a geography (e.g. acs1 below the population threshold, or 2020 acs1): emit a null point and a warning rather than crashing.
- Mixed datasets in one chart are out of scope for v1; one `dataset` per chart.
- Census sentinel negatives map to null.
- Decennial vintage variable code differences are handled by the per-vintage registry keys.

## Build Order

1. Schema and parse (`schema.ts`) with the Rogers vs Springdale TOML as a fixture. Get `validate` working first.
2. Registry and geography resolution offline, with ambiguity detection and `resolve` / `metrics`.
3. Census client with filesystem cache; `build` emitting tidy JSON. Verify Rogers and Springdale numbers look plausible against published values.
4. Compile step to LayerChart props.
5. SvelteKit routes and chart rendering for a single chart.
6. Watcher plus SSE plus newest-first menu plus toast.
7. Optional `screenshot`.

## Acceptance Criteria

- Dropping `charts/rogers-vs-springdale-population.toml` into the directory makes the chart appear with a toast and at the top of the menu, with no app restart.
- The TOML contains no FIPS codes and no variable codes.
- `bun cli/census.ts validate charts/rogers-vs-springdale-population.toml` passes.
- `bun cli/census.ts build ...` writes a tidy dataset whose Rogers and Springdale population values match published ACS 5-year estimates for the requested years.
- An ambiguous place name fails validation with a candidate list rather than rendering wrong data.
