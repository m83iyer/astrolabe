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

- `app/` — the static site: `index.html`, `styles.css`, `scene.js` (the
  3D engine — floating-origin free-flight camera in Galactocentric
  parsecs, log-scale zoom, a custom point shader for log-brightness star
  sizing), `ui.js` (navigator, layer toggles, Sources panel),
  `data/` (everything numeric; the two star-catalog `.bin` files are not
  in git — see Hosting below).
- `scripts/` — the data pipeline: `frames.py` (the single, verified
  ICRS/Galactic->Galactocentric coordinate transform every other script
  imports — never duplicated), `gaia_tap.py` (shared Gaia/VizieR async
  TAP client), `bin_layout.py` (struct-of-arrays binary writer),
  `build_tier_a.py` (structure: Cepheids, masers, open + globular
  clusters, landmarks), `build_tier_b.py` (bright stars: Gaia DR3 G<10 +
  Hipparcos-2 for Gaia's saturation gap + real IAU star names),
  `build_tier_c.py` (the solar neighborhood: Gaia Catalogue of Nearby
  Stars, ~331k stars within 100 pc), `build_model_arms.py` (the Model
  layer: 7 spiral-arm curves from Reid+2019's log-periodic fits, cross-
  checked against Tier A's real masers as an independent oracle).
- `DATA_SCHEMA.md` — the data contract.

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
at https://m83iyer.github.io/astrolabe/. The quantized star-catalog
binaries (Tier B/C — real, generated data, but the wrong shape for git
history) ship as assets on the `data-v1` GitHub Release instead; the
deploy workflow downloads them into `app/data/` before publishing.

## Status

Live, real data: 805,929 stars (Tier B + Tier C combined) and 9,569
structure tracers (Cepheids, masers, open + globular clusters) from
Gaia DR3, the Gaia Catalogue of Nearby Stars, Hipparcos-2, Skowron+2019,
Reid+2019, Hunt & Reffert 2023, and the Baumgardt+ globular cluster
orbit database — fetched, hashed, and cited, not estimated.

The **Model** layer is now built: all 7 of Reid+2019's spiral arms
(3-kpc, Norma, Scutum-Centaurus, Sagittarius-Carina, Local, Perseus,
Outer), each a log-periodic curve transcribed from the paper's own
fitted parameters (Table 2), rendered as soft purple lines distinct
from any Measured layer. These curves were cross-checked against Tier
A's real, independently-positioned masers (which carry this same
paper's arm-membership labels) as an oracle — a real check that caught
and fixed three genuine bugs during development (a sign error in the
azimuth convention, a Norma/Outer arm-grouping mismatch, and a maser
right-ascension unit bug that had scrambled some positions by 15x).
After those fixes, most arms match their labeled masers well; a few
(Scutum-Centaurus and Sagittarius most notably) still show a wider
scatter than the rest even after the same fixes were reconfirmed
against all seven arms — the paper's own text notes some Table 1
sources were excluded from its Table 2 fits, and this reconstruction's
60-point polyline can't match the paper's continuous fit as tightly as
its own internal precision. Rather than hide that gap, each affected
arm carries an honest `confidence_note` in the shipped data
(`app/data/tier_a_structure.json`), and the in-app Sources panel cites
the paper directly.

One gap still open: there's no real per-object detail panel yet
(clicking a landmark shows only its distance from the Sun).
