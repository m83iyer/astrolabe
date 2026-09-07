# Astrolabe

A real, navigable map of the Milky Way — item 2 in the "Space Exploration"
collection (sibling to [Orrery](https://github.com/m83iyer/orrery), the
solar system). Fly through the galaxy's real structure: hundreds of
thousands of individually catalogued stars near the Sun, star-forming
regions and clusters that trace the disk out to tens of thousands of
light-years, and the galaxy's spiral-arm shape and disk — all built from
live astronomical catalogs, not an illustration.

## Why this looks different from Orrery

Orrery is exact: every planet is a real body with a real orbit, rendered
at true relative size and distance. A galaxy can't work that way — no
catalog has measured the 3D position of every star in the Milky Way (dust
hides most of the far disk, and most stars are simply too faint to have
been individually surveyed). So this app is built from two honest,
visually distinct layers instead of one seamless picture:

- **Measured** — real catalogued objects, each with a source and a
  distance: individual stars (Gaia, Hipparcos), star-forming regions
  (Cepheids, masers), open and globular clusters. Rendered as crisp
  points.
- **Model** — the galaxy's overall shape (spiral arms, disk, bar) inferred
  from those measured tracers plus published structural fits, since no
  single catalog covers the whole disk. Rendered as a soft glow and ridge
  lines, never mistaken for individual stars, and labeled as inferred.

The scene itself stays real and linear (parsecs, Galactocentric
coordinates) — the only intentional distortions are a log-scale zoom
control (so both a few light-years and the whole ~100,000-light-year disk
are navigable) and log-scale star brightness (so distant structure is
visible at all). Both are disclosed in-app, not hidden.

**No animation.** Spiral arms are density waves, not a fixed shape stars
physically orbit around — there's no honest way to "spin" this scene
without fabricating motion no catalog actually measured. This is a real
snapshot (Gaia DR3 epoch, J2016.0) you fly through freely.

## Structure

- `app/` — the static site, following Orrery's pattern: static
  Three.js/WebGL site, data-driven, no build step.
- `scripts/` — the data pipeline: per-source fetch scripts that save raw
  data + sha256 to the SSD and record every source in
  `app/data/sources.json`, the same integrity pattern as Orrery.
- `DATA_SCHEMA.md` — the data contract (once M1 lands).

## Data integrity

Same standard as Orrery: every object traces to a fetched, hashed,
live-verified source, visible in-app via a "Sources" panel split by layer
(Measured vs. Model). Where the published structure of the galaxy exists
only in a paper (spiral-arm geometry, disk/bulge/bar dimensions — not a
queryable catalog), the source PDF is fetched, hashed, and the extracted
numbers are checked against independent tracer data rather than typed
from memory.

## Hosting

Static site served from `app/` via GitHub Pages
(`.github/workflows/deploy-pages.yml`, deploys on push to `main`), live
at https://m83iyer.github.io/astrolabe/.

## Status

Scaffolding — data pipeline and rendering core in progress.
