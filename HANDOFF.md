# Astrolabe — Handoff to Codex

**Prepared:** 2026-09-07T16:04Z
**By:** Claude (Sonnet 5)
**For:** Codex, resuming in this project directory
**Repo:** `/Users/manojiyer/Library/Mobile Documents/com~apple~CloudDocs/Claude/projects/astrolabe` (GitHub: `m83iyer/astrolabe`, `main`)
**Live:** https://m83iyer.github.io/astrolabe/
**Starting point:** commit `b8ad56f` — pushed, deployed, verified live (screenshots + console + network checks, not just "the build succeeded")
**Coordination:** `.ai/coordination.json` in this repo now records `driver: codex`, `reviewer: claude`, `status: approved`, milestone below. Run `claim --actor codex` (see the shared coordination tool, referenced from the root `CLAUDE.md`) before editing, per the standard protocol.

Read this whole file before touching code — it's short on purpose. `README.md` and `DATA_SCHEMA.md` in this repo are the durable project docs; this file is only the delta: what changed this session, what's still open, and what will cost you time if you don't know it going in.

## What this project is

A real, navigable 3D map of the Milky Way — sibling to [Orrery](https://github.com/m83iyer/orrery) (the solar system) in the "Space Exploration" collection. Static site (`app/`), no backend. Two honest layers, both real data: **Measured** (individually catalogued objects — Gaia/Hipparcos stars, Cepheids, masers, clusters) and **Model** (inferred shapes — currently just the 7 spiral arms; disk/bar still open, see below). Full architecture is in `README.md`; the exact JSON/binary shapes are in `DATA_SCHEMA.md` — read both before writing new pipeline code, since the schema already anticipates the disk/bar fields you'd be filling in.

## What's real and shipped right now

- 805,929 stars (Tier B bright + Tier C neighborhood, Gaia DR3 + Hipparcos-2), 9,569 structure tracers (Cepheids, masers, open + globular clusters), all with real per-source citations in `app/data/sources.json`.
- The Model layer: all 7 of Reid+2019's spiral arms, rendered as toggleable `THREE.Line` objects, cross-checked against real masers as an independent oracle (`scripts/build_model_arms.py`). Two arms (Scutum-Centaurus, Sagittarius) carry an honest `confidence_note` in the shipped JSON rather than a hidden or faked precision claim — read the docstring and comments in that script before changing the spiral-arm math, it explains three real bugs it caught and why the residual gap is disclosed rather than "fixed" further.
- Click-to-inspect works for landmarks (Sun, Sagittarius A*) with real flashcard content (`app/data/landmark_facts.json`) and for structure-tracer points (shows name/type/distance/source).
- Zoom slider + presets, layer toggles (Measured / Model), Sources panel citing every source split by layer.

Don't re-derive or re-verify any of the above from first principles — it's committed, deployed, and was checked against the live URL, not just locally. Do treat `scripts/frames.py` (the ICRS/Galactic→Galactocentric coordinate transform) as the one true implementation; every other script imports it, never re-derive the rotation.

## What's still open — the actual next milestone

`.ai/coordination.json` names this milestone; these are its acceptance criteria, each independently verifiable:

1. **Disk and bar model shapes.** `DATA_SCHEMA.md`'s `model` section already documents the intended shape (`disk: {kind, scale_length_pc, scale_height_pc, source}`, `bar: {kind, params, source}`, both pointing at Bland-Hawthorn & Gerhard 2016 as the likely source). Only `spiral_arms` exists today. Same discipline as the arms: fetch the real source, verify actual returned values against a known reference before trusting any column/field description (see Gotchas below — this is exactly the bug that cost the most time this session), render distinctly but consistently with the existing Model-layer visual language (`--model` purple, additive blending, `depthWrite:false` — see `app/scene.js`'s `buildTierAStructure()` for the pattern to copy), gate behind the same `#toggle-model` toggle.
2. **`app/data/sources_stars.json` is 404 right now.** `app/ui.js` line ~98 already fetches it (gracefully degrades to nothing, so nothing user-visible is broken, but the Sources panel is silently missing Tier B/C's citations: Gaia DR3 archive query, Hipparcos-2, the IAU-CSN name list `build_tier_b.py` already uses). Build the real file with real fetched/hashed sources in the same `{url, fetched_utc, sha256, local_file, supplies, layer}` shape as `sources.json` — don't invent a second format.
3. **No real per-object detail panel for non-landmarks.** Clicking a cepheid/maser/cluster/named star currently shows only name/type/distance/source (see `pickStructurePoint()` in `scene.js`). Tier B already carries real IAU names (`tier_b_names.json`) and Tier A's masers already carry real arm labels — surface what's already in the data before fetching anything new.

None of this is invented scope — it's the gap between what shipped and what `DATA_SCHEMA.md` (written this session, before any of the tiers existed) and `README.md`'s own "Status" section already said was open.

Softer, non-blocking observation (judgment call, not a defect): the default "Whole Galaxy" 60kpc zoom preset frames the disk fairly obliquely — the bright core cluster dominates the frame and the spiral arms read as a tight tangle near center rather than fanning out. A more face-on default framing might show the Model layer off better. Not filed as an acceptance criterion because it's a taste call, not a bug — your call whether it's worth revisiting.

## House rules that carry over (from the root `CLAUDE.md`, restated because they're load-bearing here)

- **Zero fabrication.** Every number on screen must trace to a real fetched, hashed source in `sources.json` (or the new `sources_stars.json`). No placeholder/estimated values ship silently — if real data isn't reachable, the existing fallback (`buildPlaceholderUniverse()`) makes that obvious in-app rather than pretending.
- **`.bin` files never go to git.** `git_binary_guard.py` blocks it (real incident, see the comment in `.gitignore`). New binary data ships as a new asset on the `data-v1` GitHub Release (`gh release upload data-v1 <file> --repo m83iyer/astrolabe --clobber`), downloaded by `.github/workflows/deploy-pages.yml` at deploy time — follow that existing pattern, don't invent a new hosting path.
- **Verify on the live URL, not just locally.** One real bug this session (a cache-poisoning issue in `loadLandmarkFacts()`) only showed up in production, never locally. After any change, push, wait for the Pages deploy (`gh run list`, poll for `status=completed` — never `gh run watch`), then actually check `https://m83iyer.github.io/astrolabe/` — console errors, network requests, and a real screenshot, not just "the deploy succeeded."
- **GitHub Actions dispatch** for this repo is just the existing `push`-triggered `deploy-pages.yml` — no budget-guard wrapper needed for that (it's free, lightweight Pages hosting), but don't add new scheduled/matrix workflows without checking the shared Actions budget guard first.

## Gotchas that cost real time this session (read before you hit them again)

- **A VizieR/TAP column's metadata *description* can lie about the actual returned unit.** The maser RA bug (main thing `build_model_arms.py`'s oracle caught): the column description said "hours," the API actually returned decimal degrees already. Always spot-check one real returned value against an independent known reference before trusting a field's stated unit — this will bite again on any new VizieR source (very plausible for the disk/bar sourcing above).
- **A plain `THREE.LineBasicMaterial` with alpha blending is nearly invisible against this app's bright additive-blended point clouds.** Every visible layer in `scene.js` uses `blending: THREE.AdditiveBlending, depthWrite: false` — match it for any new Model-layer geometry or it'll render but be practically invisible (this exact bug shipped once this session before being caught in a real screenshot).
- **The floating-origin pattern**: `measuredLayer`/`modelLayer` content is built in absolute Galactocentric parsecs; `scene.position` is shifted every frame in `tick()` to re-center on the camera. Any new object just needs to go into the existing scene graph (e.g., inside `modelLayer`) — don't hand-roll a separate origin shift for it.
- If you're driving a browser preview yourself: this session's Browser-pane tooling intermittently reports `document.hidden=true` / `innerWidth=0` when the tab isn't frontmost, which breaks click coordinates and camera aspect math. If that happens, front the tab explicitly and retry, or drive state/math checks directly via the console rather than trusting a screenshot taken while hidden. This may be specific to that tool, not necessarily something you'll hit.

## Reference

- `/Users/manojiyer/Library/Mobile Documents/com~apple~CloudDocs/Codex/reference/CLAUDE_CODEX_OPERATING_PROTOCOL.md` — the shared driver/reviewer protocol this handoff follows.
- `/Users/manojiyer/Library/Mobile Documents/com~apple~CloudDocs/Codex/system/claude_codex_coordination.py` — the tool that wrote `.ai/coordination.json`; use `claim`/`handoff`/`status` as you work.
- Git log (`git log --oneline`) is a reasonably clean, one-topic-per-commit history of exactly how this app was built — cheaper to read than to ask.
