#!/usr/bin/env python3
"""Build Tier C -- the solar-neighborhood star catalog.

Source: Gaia Catalogue of Nearby Stars (GCNS), TAP table
external.gaiaedr3_gcns_main_1 on the Gaia TAP service. ~331k stars within
100 pc of the Sun.

Position: GCNS publishes xcoord_50/ycoord_50/zcoord_50 as HELIOCENTRIC
Galactic-frame Cartesian pc (verified against scripts/frames.py on live
sample rows -- NOT Galactocentric, despite how they are sometimes
described informally). This script converts to this app's Galactocentric
frame with a single translation using frames.py's own published constant
(SUN_GALACTOCENTRIC_PC), never a new transform:

    galactocentric_xyz = SUN_GALACTOCENTRIC_PC + [xcoord_50, ycoord_50, zcoord_50]

This is algebraically identical to frames.galactic_to_galactocentric_pc(l,
b, dist) for the same star (spot-checked to 4 decimal places on 5 sample
rows spanning 1.3-2.7 pc) -- it just skips the redundant re-derivation
from ra/dec/distance since GCNS already did the l/b/distance trig.
"""
import sys
import os
import hashlib
import json
import time
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames
import gaia_tap
import bin_layout

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "app", "data")
ARTIFACT_DIR = "/Volumes/Media/AutomationStore/project-artifacts/astrolabe/2026-09-07/tier_bc"

GCNS_QUERY = """
SELECT source_id, xcoord_50, ycoord_50, zcoord_50,
       phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag
FROM external.gaiaedr3_gcns_main_1
""".strip()


def _f(v):
    if v is None or v == "":
        return np.nan
    return float(v)


def fetch_gcns(log=print):
    log("[tier_c] submitting GCNS async TAP query...")
    t0 = time.time()
    csv_text = gaia_tap.tap_async_query(GCNS_QUERY, poll_interval=15, max_wait=1800, log=log)
    log(f"[tier_c] GCNS query complete in {time.time()-t0:.0f}s, {len(csv_text)} bytes")
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    raw_path = os.path.join(ARTIFACT_DIR, "gcns_raw.csv")
    with open(raw_path, "w") as f:
        f.write(csv_text)
    sha256 = hashlib.sha256(csv_text.encode("utf-8")).hexdigest()
    log(f"[tier_c] raw CSV saved to {raw_path} sha256={sha256}")
    return csv_text, raw_path, sha256


def build(log=print):
    csv_text, raw_path, sha256 = fetch_gcns(log=log)
    rows = gaia_tap.csv_to_rows(csv_text)
    n = len(rows)
    log(f"[tier_c] parsed {n} rows")

    source_id = np.empty(n, dtype=np.int64)
    x_helio = np.empty(n, dtype=np.float64)
    y_helio = np.empty(n, dtype=np.float64)
    z_helio = np.empty(n, dtype=np.float64)
    mag = np.empty(n, dtype=np.float64)
    bp = np.empty(n, dtype=np.float64)
    rp = np.empty(n, dtype=np.float64)

    for i, r in enumerate(rows):
        source_id[i] = int(r["source_id"])
        x_helio[i] = _f(r["xcoord_50"])
        y_helio[i] = _f(r["ycoord_50"])
        z_helio[i] = _f(r["zcoord_50"])
        mag[i] = _f(r["phot_g_mean_mag"])
        bp[i] = _f(r["phot_bp_mean_mag"])
        rp[i] = _f(r["phot_rp_mean_mag"])

    n_missing_xyz = int(np.sum(np.isnan(x_helio) | np.isnan(y_helio) | np.isnan(z_helio)))
    if n_missing_xyz:
        log(f"[tier_c] WARNING: {n_missing_xyz} rows missing xyz -- dropping (cannot place them)")
        keep = ~(np.isnan(x_helio) | np.isnan(y_helio) | np.isnan(z_helio))
        source_id, x_helio, y_helio, z_helio, mag, bp, rp = (
            a[keep] for a in (source_id, x_helio, y_helio, z_helio, mag, bp, rp)
        )
        n = len(source_id)

    # The one and only coordinate operation performed here: translate GCNS's
    # already-heliocentric Galactic xyz into this app's Galactocentric frame
    # using frames.py's own published Sun offset -- not a re-derivation.
    x_pc = frames.SUN_GALACTOCENTRIC_PC[0] + x_helio
    y_pc = frames.SUN_GALACTOCENTRIC_PC[1] + y_helio
    z_pc = frames.SUN_GALACTOCENTRIC_PC[2] + z_helio

    bp_rp = bp - rp  # NaN-propagates correctly where either band is absent

    n_missing_mag = int(np.sum(np.isnan(mag)))
    n_missing_color = int(np.sum(np.isnan(bp_rp)))
    log(f"[tier_c] missing phot_g_mean_mag: {n_missing_mag}, missing bp_rp: {n_missing_color}")

    os.makedirs(DATA_DIR, exist_ok=True)
    bin_path = os.path.join(DATA_DIR, "tier_c_neighborhood.bin")
    meta_path = os.path.join(DATA_DIR, "tier_c_neighborhood.meta.json")

    columns, n_rows, total_bytes = bin_layout.write_soa_binary(bin_path, [
        ("x_pc", "float32", x_pc, "Galactocentric pc, +x toward Sun per DATA_SCHEMA.md"),
        ("y_pc", "float32", y_pc, "Galactocentric pc"),
        ("z_pc", "float32", z_pc, "Galactocentric pc, +z toward NGP"),
        ("phot_g_mean_mag", "float32", mag, "Gaia G-band apparent magnitude"),
        ("bp_rp", "float32", bp_rp, "Gaia BP-RP color index; NaN if either band missing"),
        ("source_id", "int64", source_id, "Gaia EDR3 source_id (read as BigInt64Array)"),
    ])

    bin_layout.write_meta_json(
        meta_path,
        tier="c_neighborhood",
        description="Solar-neighborhood stars within 100 pc, from the Gaia Catalogue of Nearby Stars (GCNS).",
        row_count=n_rows,
        total_bytes=total_bytes,
        columns=columns,
        extra={
            "source": "Gaia EDR3 external.gaiaedr3_gcns_main_1 via Gaia TAP async query",
            "source_note": "GCNS xcoord_50/ycoord_50/zcoord_50 are HELIOCENTRIC Galactic-frame Cartesian pc (verified against scripts/frames.py, not Galactocentric as originally assumed) -- converted here via a single translation using frames.SUN_GALACTOCENTRIC_PC.",
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "rows_dropped_missing_position": n_missing_xyz,
            "rows_missing_mag": n_missing_mag,
            "rows_missing_bp_rp": n_missing_color,
        },
    )
    log(f"[tier_c] wrote {bin_path} ({total_bytes} bytes, {n_rows} rows)")
    log(f"[tier_c] wrote {meta_path}")

    return {
        "row_count": n_rows,
        "bin_path": bin_path,
        "meta_path": meta_path,
        "total_bytes": total_bytes,
        "source_url": gaia_tap.GAIA_TAP_BASE + "/sync",
        "raw_path": raw_path,
        "sha256": sha256,
        "adql": GCNS_QUERY,
    }


if __name__ == "__main__":
    result = build()
    print(json.dumps({k: v for k, v in result.items() if k != "adql"}, indent=2))
