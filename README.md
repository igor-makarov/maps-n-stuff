# Maps n Stuff

Four coordinated Shurik agents build an OldMapsOnline-style historical-map
application using the official Canton Zürich design system and original map
collections, delivered as a **Cloudflare Workers site** with Wrangler configuration
and local preview/deploy commands. The shared brief is in [PROMPT.md](PROMPT.md). Agents choose their own
coordination method and deliver completed, validated changes directly to `main`.

## The application: Kartenzeit

**Kartenzeit** is the product this swarm builds: an OldMapsOnline-style explorer
for historical maps, styled with the official [Canton Zürich design system](https://github.com/Kanton-Zurich/frontend-designsystem)
and fed exclusively from documented original sources (e-rara / Zentralbibliothek
Zürich IIIF + OAI-PMH, swisstopo WMTS geoservices and SearchServer). It is an
independent project and not a cantonal website.

What works today (verified with `wrangler dev` + headless Chromium):

- pan/zoom map on swisstopo base tiles, with georeferenced historical map layers
  (Zeitreise 1850–2021, Siegfriedkarte 1870–1949, Dufourkarte, SWISSIMAGE Zeitreise
  aerial imagery 1946–2020) including edition slider, opacity and attribution;
- place search against the swisstopo search service (proxied and edge-cached by the
  Worker) with keyboard-operable suggestions and “quick pick” places;
- publication-year range, collection, type and “only in the current map view”
  filters that drive both the result list and the map markers;
- coordinated result list ↔ map selection, list/map/split view switch;
- detail panel with publication vs depicted dates, institution, shelfmark, rights,
  an interactive IIIF deep-zoom viewer (region requests, drag/pinch/keyboard, sheet
  navigation), a link to the library's own viewer and a prominent link to the
  original record — plus “use this sheet's period as the time filter”;
- a comparison list: pin up to four records, share the list as `?cmp=…`, and put
  two or more of them side by side with their real IIIF/WMTS previews, metadata
  and links back to the original records;
- shareable URL state (`q`, `from`, `to`, `p`, `t`, `vp`, `place`, `lat`, `lon`, `z`,
  `sel`, `view`, `sort`, `ov`, `ot`, `cmp`) and a keyboard route for every map
  action.

```sh
npm install
npm run dev      # http://127.0.0.1:8787  (static assets + /api/* Worker)
npm run check    # build validation + node --test + wrangler deploy --dry-run
```

Cloudflare build settings (Workers Builds): root directory `/`, build command
`npm run build`, deploy command `npx wrangler deploy`; no secrets or bindings
beyond the `ASSETS` static-asset binding. `public/_headers` adds the security
headers (CSP, `nosniff`, referrer/frame/permissions policy) and cache lifetimes
for the Workers static assets. Details, API description, data refresh
and troubleshooting: [docs/run.md](docs/run.md). Design derivation (tokens,
typography, indentation, focus): [docs/design-system.md](docs/design-system.md).
Source registry and verification evidence: [docs/data-sources.md](docs/data-sources.md).

Known limitations: the seed set holds 66 records (39 e-rara maps — 20 ZB Zürich
Wildkarte sheets, 18 Swiss maps from ETH-Bibliothek holdings, 1 map from the
Bibliothèque de Genève — plus 27 georeferenced swisstopo overlay editions; the UI
states the real count and `records.json.selection` documents the rule per set).
`public/vendor/leaflet` is vendored but unused; without network access the tiles
and IIIF images stay empty while metadata remains readable (the detail panel then
keeps the metadata, the provider links and an explanation).

## Swarm configuration

- Action: [`igor-makarov/shurik@v2`](https://github.com/igor-makarov/shurik)
- Model: `opencode-go/deepseek-v4.1-flash`, reasoning `max`
- Members: `zurich-maps-0`, `zurich-maps-1`, `zurich-maps-2`, `zurich-maps-3`
- Work per iteration: 1,800 seconds; periodic checkpoints disabled (`0`)
- Wait between iterations: zero; no overall deadline
- Delivery: `main`, with draft PR creation disabled

The official `@v2` release supports `checkpoint-seconds: 0`; the workflow now uses
that supported setting directly.

Shurik itself gives each member an independent task branch and
`shurik-control/<member-id>` branch. The brief explicitly tells agents to coordinate
and make their own product commits and pushes to `main`. Session-start and
iteration-end saves of the task branch and session/control state remain enabled.
Agents must preserve their assigned task branch's published history so these
boundary pushes can fast-forward. Unpushed code and in-progress session history
can be lost on an abrupt runner interruption.
Shurik does not provide built-in inter-agent messaging or automatic integration.

## Initial launch

Add the **`OPENCODE_API_KEY`** repository Actions secret with access to the model.
No credential belongs in the launch JSON, prompt, Git history, or dispatch inputs.

Pushing a change to [`.github/shurik/launch.json`](.github/shurik/launch.json) on
`main` starts the four-member swarm if no members have been initialized, through
[`.github/workflows/shurik.yml`](.github/workflows/shurik.yml). Ordinary product,
prompt, or workflow commits do not trigger another swarm. Updating the launch
request for an existing swarm also skips initialization; use the brief-update
workflow to apply settings to its saved members. The control job checks
for the secret before creating loops; if it is missing, add it and rerun that
failed job. If startup has already created any members, inspect their state before
retrying: Shurik rejects reusing initialized loop IDs.

Changes to `PROMPT.md` on `main` run the brief-update workflow: it stops each
existing member, copies only the latest brief onto its task branch, and resumes
the saved loop. Product work and the agents' chosen coordination method remain
theirs to manage. This workflow can also be run manually after a failed update.
It resumes all four with periodic checkpoints disabled.

Cloudflare deployment credentials are not forwarded to the swarm. Agents prepare
and validate the application source and Workers configuration, and document the
required root directory, build command, and deploy command. **Cloudflare handles
the production build and deployment from `main`.** The swarm does not deploy.

The workflow needs contents and Actions write permissions. Agents also need to be
able to push to `main` under the repository's branch rules. Its scheduled recovery
runs every 15 minutes, subject to GitHub scheduling delays. Loops keep iterating
until stopped or given a deadline; work-seconds is a time budget, not a spending
cap. The provider validates availability and support for `max`; do not silently
substitute a model or lower reasoning.

## Control existing members

Use **Actions → Shurik → Run workflow** on `main`, or the GitHub CLI. Stop/resume
requires an individual member ID, not the swarm prefix. For example:

```sh
gh workflow run shurik.yml --ref main \
  -f command=stop -f loop_id=zurich-maps-0

gh workflow run shurik.yml --ref main \
  -f command=resume -f loop_id=zurich-maps-0
```

Leave model, swarm, and timing fields blank when resuming to retain their saved
values. A blank resume deadline clears any previous deadline. Stop all four:

```sh
for member in zurich-maps-0 zurich-maps-1 zurich-maps-2 zurich-maps-3; do
  gh workflow run shurik.yml --ref main -f command=stop -f loop_id="$member"
done
```

For a genuinely new swarm, choose a fresh prefix and use explicit settings:

```sh
gh workflow run shurik.yml --ref main \
  -f command=start -f loop_id=zurich-maps-next \
  -f model='{"provider":"opencode-go","name":"deepseek-v4.1-flash","reasoning":"max"}' \
  -f swarm='{"agents":4}' -f create_pr=false -f prompt=PROMPT.md
```
