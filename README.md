# Maps n Stuff

Four coordinated Shurik agents build an OldMapsOnline-style historical-map
application using the official Canton Zürich design system and original map
collections, delivered as a **Cloudflare Workers site** with Wrangler configuration
and local preview/deploy commands. The shared brief is in [PROMPT.md](PROMPT.md). Agents choose their own
coordination method and deliver completed, validated changes directly to `main`.

## Swarm configuration

- Action: [`igor-makarov/shurik@v2`](https://github.com/igor-makarov/shurik)
- Model: `opencode-go/deepseek-v4.1-flash`, reasoning `max`
- Members: `zurich-maps-0`, `zurich-maps-1`, `zurich-maps-2`, `zurich-maps-3`
- Work per iteration: 1,800 seconds; checkpoint interval: 300 seconds
- Wait between iterations: zero; no overall deadline
- Delivery: `main`, with draft PR creation disabled

Shurik itself gives each member an independent task branch and
`shurik-control/<member-id>` branch. The brief explicitly tells agents to coordinate
and integrate their product commits on `main` while preserving those checkpoints.
Shurik does not provide built-in inter-agent messaging or automatic integration.

## Initial launch

Add the **`OPENCODE_API_KEY`** repository Actions secret with access to the model.
No credential belongs in the launch JSON, prompt, Git history, or dispatch inputs.

Pushing a change to [`.github/shurik/launch.json`](.github/shurik/launch.json) on
`main` starts the four-member swarm through
[`.github/workflows/shurik.yml`](.github/workflows/shurik.yml). Ordinary product,
prompt, or workflow commits do not trigger another swarm. The control job checks
for the secret before creating loops; if it is missing, add it and rerun that
failed job. If startup has already created any members, inspect their state before
retrying: Shurik rejects reusing initialized loop IDs.

Changes to `PROMPT.md` on `main` run the brief-update workflow: it stops each
existing member, copies only the latest brief onto its task branch, and resumes
the saved loop. Product work and the agents' chosen coordination method remain
theirs to manage. This workflow can also be run manually after a failed update.

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
