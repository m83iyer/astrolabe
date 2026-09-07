# Astrolabe data contract

All coordinates are **Galactocentric Cartesian, in parsecs**: origin at
the galactic center, +x toward the Sun's *opposite* side is NOT the
convention — instead we use the common astropy-style convention: +x
points from the galactic center toward the Sun's direction is avoided
too, to prevent ambiguity. Concretely: **x, y in the galactic plane, z
toward the North Galactic Pole, with the Sun at (x, y, z) = (-8150, 0,
+20.8) pc** (Reid et al. 2019 R0 = 8.15 kpc; Sun's height above the plane
~20.8 pc, Bennett & Bovy 2019). The Galactic Center (Sgr A*) is at the
origin (0, 0, 0).

Frame derivation (pure numpy, no astropy dependency): ICRS (ra, dec) or
Galactic (l, b) + distance -> Galactocentric XYZ, via the standard
IAU/Hipparcos-defined Galactic pole (RA=192.85948, Dec=27.12825, J2000)
and origin of galactic longitude, then translated so the Sun sits at the
coordinates above. `scripts/frames.py` is the single implementation both
the pipeline and `oracle_frames.py` import — never duplicate this math.

## app/data/manifest.json

```json
{
  "epoch": "J2016.0",
  "epoch_note": "Gaia DR3 reference epoch — this is a snapshot, not a live simulation (see README: no animation)",
  "generated_utc": "...",
  "sun_galactocentric_pc": [-8150, 0, 20.8],
  "galactic_center_galactocentric_pc": [0, 0, 0],
  "tiers": {
    "a_structure": {"file": "tier_a_structure.json", "count": 0, "layer": "mixed"},
    "b_bright_stars": {"file": "tier_b_bright_stars.bin", "count": 0, "layer": "measured", "load_below_altitude_pc": 5000},
    "c_neighborhood": {"file": "tier_c_neighborhood.bin", "count": 0, "layer": "measured", "load_below_altitude_pc": 300}
  }
}
```

## Tier A — structure (JSON, always loaded)

`app/data/tier_a_structure.json`:

```json
{
  "measured": {
    "cepheids": [{"name": "...", "x_pc": 0, "y_pc": 0, "z_pc": 0, "source": "Skowron+2019"}],
    "masers": [{"name": "...", "x_pc": 0, "y_pc": 0, "z_pc": 0, "arm": "Perseus", "source": "Reid+2019"}],
    "open_clusters": [{"name": "...", "x_pc": 0, "y_pc": 0, "z_pc": 0, "source": "Hunt & Reffert 2023"}],
    "globular_clusters": [{"name": "...", "x_pc": 0, "y_pc": 0, "z_pc": 0, "source": "Baumgardt+ orbits DB v4"}],
    "landmarks": [{"name": "Sun", "x_pc": -8150, "y_pc": 0, "z_pc": 20.8}, {"name": "Sagittarius A*", "x_pc": 0, "y_pc": 0, "z_pc": 0}, "... LMC, SMC ..."]
  },
  "model": {
    "spiral_arms": [{"name": "Perseus", "points_pc": [[0,0,0]], "source": "Reid+2019 Table 2 (extracted from PDF, see sources.json)"}],
    "disk": {"kind": "exponential", "scale_length_pc": 0, "scale_height_pc": 0, "source": "Bland-Hawthorn & Gerhard 2016"},
    "bar": {"kind": "...", "params": {}, "source": "Bland-Hawthorn & Gerhard 2016"}
  }
}
```

Every object in `measured` carries a real name/id traceable to its source
row. Every object in `model` is a derived/fitted shape, never an
individually measured position — the renderer must be able to draw these
two groups with visually distinct materials (points vs. glow/lines) from
this split alone, without inspecting individual fields.

## Tier B / C — star catalogs (binary, lazy-loaded)

Quantized flat binary (not JSON — these are 300k-1M+ rows): a small JSON
header (`tier_b_bright_stars.meta.json` / `tier_c_neighborhood.meta.json`)
declaring column layout, dtype, and quantization scale/offset per column,
followed by a raw `.bin` of fixed-width records. Exact layout is the
pipeline-building agent's call (record it in the meta file, not just in
code) — at minimum: x_pc, y_pc, z_pc (float32 or scaled int32), bp_rp
color index or equivalent, apparent/absolute magnitude, and a source id
(Gaia `source_id` or HIP number) for the info-panel lookup. A separate
`tier_b_names.json` / sparse map covers the subset with real IAU names
(from the WGSN list) — most stars have no proper name and the UI should
say so rather than inventing one.

## app/data/sources.json

Same shape as Orrery's: array of `{url, fetched_utc, sha256, local_file,
supplies, layer}` — `layer` is new here (`"measured"` or `"model"`) so
the in-app Sources panel can split by layer as designed.
