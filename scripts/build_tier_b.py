#!/usr/bin/env python3
"""Build Tier B -- bright stars beyond the immediate solar neighborhood.

Two sources, joined by position (not by ID -- they're different catalogs):
1. Gaia DR3 gaiadr3.gaia_source, G<10 AND parallax/parallax_error>5, joined
   to external.gaiaedr3_distance for Bailer-Jones photogeometric distances
   (r_med_photogeo) -- real row count at this cut confirmed live in this
   session: 475,641 (not Gaia's full ~1.8B, and not the "well over a
   million" first assumed for G<10 -- that estimate was for G<11).
2. Hipparcos-2 (VizieR I/311/hip2, 117,955 rows) for stars BRIGHTER than
   Gaia's own saturation limit -- confirmed live this session that Gaia
   DR3 has NO rows at all for Sirius/Vega/Canopus/Arcturus/alpha Cen A
   (cone searches at each position returned nothing). Any Hipparcos star
   with Hp < 4 is kept unconditionally (well inside Gaia's saturation
   gap); dedup against Gaia by angular separation, not by assuming the
   two catalogs are disjoint.

IAU star names (WGSN list) are attached where a cross-match succeeds;
most rows get none, which is correct, not a gap to fill.
"""
import sys
import os
import re
import hashlib
import json
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames
import gaia_tap
import bin_layout

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "app", "data")
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
ARTIFACT_DIR = f"/Volumes/Media/AutomationStore/project-artifacts/astrolabe/{TODAY}/tier_bc"

GAIA_QUERY = """
SELECT g.source_id, g.ra, g.dec, g.phot_g_mean_mag, g.bp_rp,
       d.r_med_photogeo
FROM gaiadr3.gaia_source AS g
JOIN external.gaiaedr3_distance AS d ON g.source_id = d.source_id
WHERE g.phot_g_mean_mag < 10
  AND g.parallax IS NOT NULL AND g.parallax_over_error > 5
""".strip()

HIP_QUERY = """
SELECT HIP, RAdeg, DEdeg, Plx, Hpmag, "B-V"
FROM "I/311/hip2"
WHERE Hpmag < 4
""".strip()

HIP_BRIGHT_CUTOFF_MAG = 4.0  # well inside Gaia's saturation gap (confirmed empty at brighter mags this session)
DEDUP_ARCSEC = 2.0


def _f(v, default=np.nan):
    if v is None or v == "":
        return default
    try:
        return float(v)
    except ValueError:
        return default


def fetch_gaia(log=print):
    log("[tier_b] submitting Gaia bright-star async TAP query...")
    t0 = time.time()
    csv_text = gaia_tap.tap_async_query(GAIA_QUERY, poll_interval=20, max_wait=2400, log=log)
    log(f"[tier_b] Gaia query complete in {time.time()-t0:.0f}s, {len(csv_text)} bytes")
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    raw_path = os.path.join(ARTIFACT_DIR, "gaia_bright_raw.csv")
    with open(raw_path, "w") as f:
        f.write(csv_text)
    sha256 = hashlib.sha256(csv_text.encode("utf-8")).hexdigest()
    log(f"[tier_b] raw CSV saved sha256={sha256}")
    return gaia_tap.csv_to_rows(csv_text), raw_path, sha256


def fetch_hipparcos(log=print):
    log("[tier_b] fetching Hipparcos-2 bright stars via VizieR TAP sync...")
    csv_text = gaia_tap.tap_sync_query(HIP_QUERY, base=gaia_tap.VIZIER_TAP_BASE, fmt="csv", timeout=60)
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    raw_path = os.path.join(ARTIFACT_DIR, "hipparcos_bright_raw.csv")
    with open(raw_path, "w") as f:
        f.write(csv_text)
    sha256 = hashlib.sha256(csv_text.encode("utf-8")).hexdigest()
    rows = gaia_tap.csv_to_rows(csv_text)
    log(f"[tier_b] Hipparcos: {len(rows)} rows brighter than Hp={HIP_BRIGHT_CUTOFF_MAG}")
    return rows, raw_path, sha256


def fetch_iau_names(log=print):
    url = "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt"
    log("[tier_b] fetching IAU approved star names...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (astrolabe-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    raw_path = os.path.join(ARTIFACT_DIR, "iau_csn.txt")
    with open(raw_path, "wb") as f:
        f.write(raw)
    sha256 = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")
    # Columns are whitespace-delimited with a header row; HIP number and
    # approved name are what we need. Format: Name | Designation | ... | HIP | ...
    by_hip = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"\s{2,}", line.strip())
        if len(parts) < 2:
            continue
        name = parts[0].strip()
        hip_match = re.search(r"HIP\s*(\d+)", line)
        if hip_match and name and not name.isupper():
            by_hip[int(hip_match.group(1))] = name
    log(f"[tier_b] parsed {len(by_hip)} HIP->name entries")
    return by_hip, raw_path, sha256


def angular_sep_arcsec(ra1, dec1, ra2, dec2):
    ra1, dec1, ra2, dec2 = map(np.radians, (ra1, dec1, ra2, dec2))
    cos_sep = np.sin(dec1) * np.sin(dec2) + np.cos(dec1) * np.cos(dec2) * np.cos(ra1 - ra2)
    return np.degrees(np.arccos(np.clip(cos_sep, -1, 1))) * 3600


def build(log=print):
    gaia_rows, gaia_raw_path, gaia_sha = fetch_gaia(log=log)
    hip_rows, hip_raw_path, hip_sha = fetch_hipparcos(log=log)
    names_by_hip, names_raw_path, names_sha = fetch_iau_names(log=log)

    n_gaia = len(gaia_rows)
    log(f"[tier_b] Gaia rows: {n_gaia}")

    g_ra = np.array([_f(r["ra"]) for r in gaia_rows])
    g_dec = np.array([_f(r["dec"]) for r in gaia_rows])
    g_dist_pc = np.array([_f(r["r_med_photogeo"]) for r in gaia_rows])
    g_mag = np.array([_f(r["phot_g_mean_mag"]) for r in gaia_rows])
    g_bprp = np.array([_f(r["bp_rp"]) for r in gaia_rows])
    g_source_id = np.array([int(r["source_id"]) for r in gaia_rows], dtype=np.int64)

    keep = ~(np.isnan(g_ra) | np.isnan(g_dec) | np.isnan(g_dist_pc) | (g_dist_pc <= 0))
    n_dropped = int((~keep).sum())
    log(f"[tier_b] dropping {n_dropped} Gaia rows missing ra/dec/distance")
    g_ra, g_dec, g_dist_pc, g_mag, g_bprp, g_source_id = (
        a[keep] for a in (g_ra, g_dec, g_dist_pc, g_mag, g_bprp, g_source_id)
    )

    # Dedup Hipparcos against Gaia by position (Gaia saturates before Hp=4
    # so overlap should be near-zero, but check rather than assume).
    h_ra = np.array([_f(r["RAdeg"]) for r in hip_rows])
    h_dec = np.array([_f(r["DEdeg"]) for r in hip_rows])
    h_plx = np.array([_f(r["Plx"]) for r in hip_rows])
    h_hpmag = np.array([_f(r["Hpmag"]) for r in hip_rows])
    h_hip = np.array([int(r["HIP"]) for r in hip_rows], dtype=np.int64)

    h_keep = ~(np.isnan(h_ra) | np.isnan(h_dec) | np.isnan(h_plx) | (h_plx <= 0))
    h_ra, h_dec, h_plx, h_hpmag, h_hip = (a[h_keep] for a in (h_ra, h_dec, h_plx, h_hpmag, h_hip))
    h_dist_pc = 1000.0 / h_plx

    n_dedup = 0
    if n_gaia:
        h_dup = np.zeros(len(h_ra), dtype=bool)
        for i in range(len(h_ra)):
            seps = angular_sep_arcsec(h_ra[i], h_dec[i], g_ra, g_dec)
            if np.any(seps < DEDUP_ARCSEC):
                h_dup[i] = True
        n_dedup = int(h_dup.sum())
        keep_h = ~h_dup
        h_ra, h_dec, h_dist_pc, h_hpmag, h_hip = (a[keep_h] for a in (h_ra, h_dec, h_dist_pc, h_hpmag, h_hip))
    log(f"[tier_b] Hipparcos rows after dedup against Gaia: {len(h_ra)} ({n_dedup} duplicates dropped)")

    # Convert ICRS -> Galactocentric pc for both sets.
    def to_galcen(ra, dec, dist):
        out = np.empty((len(ra), 3), dtype=np.float64)
        for i in range(len(ra)):
            out[i] = frames.icrs_to_galactocentric_pc(ra[i], dec[i], dist[i])
        return out

    log("[tier_b] converting Gaia positions to Galactocentric pc...")
    g_xyz = to_galcen(g_ra, g_dec, g_dist_pc)
    log("[tier_b] converting Hipparcos positions to Galactocentric pc...")
    h_xyz = to_galcen(h_ra, h_dec, h_dist_pc) if len(h_ra) else np.zeros((0, 3))

    # Hipparcos has no bp_rp; approximate a color proxy from B-V isn't
    # fetched here to keep scope tight -- mark as NaN, renderer falls back
    # to a neutral color for these (a handful of the brightest named stars).
    h_bprp = np.full(len(h_ra), np.nan)

    x_pc = np.concatenate([g_xyz[:, 0], h_xyz[:, 0]]) if len(h_xyz) else g_xyz[:, 0]
    y_pc = np.concatenate([g_xyz[:, 1], h_xyz[:, 1]]) if len(h_xyz) else g_xyz[:, 1]
    z_pc = np.concatenate([g_xyz[:, 2], h_xyz[:, 2]]) if len(h_xyz) else g_xyz[:, 2]
    mag = np.concatenate([g_mag, h_hpmag]) if len(h_hpmag) else g_mag
    bprp = np.concatenate([g_bprp, h_bprp]) if len(h_bprp) else g_bprp
    # Encode provenance: positive = Gaia source_id, negative = -(HIP number),
    # so the renderer/info-panel can tell which catalog + look up the id.
    ids = np.concatenate([g_source_id, -h_hip.astype(np.int64)]) if len(h_hip) else g_source_id

    n_total = len(x_pc)
    log(f"[tier_b] total combined rows: {n_total} ({n_gaia - n_dropped} Gaia + {len(h_ra)} Hipparcos)")

    # Attach IAU names where the id is a HIP number with a match.
    name_ids = []
    name_strs = []
    for idx, sid in enumerate(ids):
        if sid < 0:
            hip_num = int(-sid)
            if hip_num in names_by_hip:
                name_ids.append(idx)
                name_strs.append(names_by_hip[hip_num])
    log(f"[tier_b] {len(name_ids)} rows matched to a real IAU name")

    os.makedirs(DATA_DIR, exist_ok=True)
    bin_path = os.path.join(DATA_DIR, "tier_b_bright_stars.bin")
    meta_path = os.path.join(DATA_DIR, "tier_b_bright_stars.meta.json")
    names_path = os.path.join(DATA_DIR, "tier_b_names.json")

    columns, n_rows, total_bytes = bin_layout.write_soa_binary(bin_path, [
        ("x_pc", "float32", x_pc, "Galactocentric pc"),
        ("y_pc", "float32", y_pc, "Galactocentric pc"),
        ("z_pc", "float32", z_pc, "Galactocentric pc"),
        ("mag", "float32", mag, "Gaia G-band mag (Gaia rows) or Hipparcos Hp mag (Hipparcos rows) -- not perfectly homogeneous, both are broadband optical"),
        ("bp_rp", "float32", bprp, "Gaia BP-RP color index; NaN for Hipparcos-only rows (no bp_rp fetched for those)"),
        ("catalog_id", "int64", ids, "Gaia source_id if positive; -(HIP number) if negative"),
    ])
    bin_layout.write_meta_json(
        meta_path,
        tier="b_bright_stars",
        description="Bright stars (G<10 Gaia DR3, plus Hipparcos-2 for stars brighter than Gaia's saturation limit).",
        row_count=n_rows,
        total_bytes=total_bytes,
        columns=columns,
        extra={
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "gaia_row_count": int(n_gaia - n_dropped),
            "hipparcos_row_count": int(len(h_ra)),
            "hipparcos_dedup_dropped": n_dedup,
            "named_row_count": len(name_ids),
            "gaia_cut": "phot_g_mean_mag < 10 AND parallax_over_error > 5",
            "hipparcos_cut": f"Hpmag < {HIP_BRIGHT_CUTOFF_MAG}, deduped against Gaia within {DEDUP_ARCSEC} arcsec",
        },
    )
    with open(names_path, "w") as f:
        json.dump({str(i): n for i, n in zip(name_ids, name_strs)}, f, indent=2)

    log(f"[tier_b] wrote {bin_path} ({total_bytes} bytes, {n_rows} rows)")
    log(f"[tier_b] wrote {names_path} ({len(name_ids)} names)")

    return {
        "row_count": n_rows,
        "gaia_rows": int(n_gaia - n_dropped),
        "hipparcos_rows": int(len(h_ra)),
        "named_rows": len(name_ids),
        "sources": [
            {"url": gaia_tap.GAIA_TAP_BASE + "/async", "local_file": gaia_raw_path, "sha256": gaia_sha,
             "supplies": ["tier_b bright stars (Gaia)"], "layer": "measured"},
            {"url": "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync (I/311/hip2)", "local_file": hip_raw_path, "sha256": hip_sha,
             "supplies": ["tier_b bright stars (Hipparcos, Gaia-saturation gap)"], "layer": "measured"},
            {"url": "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt", "local_file": names_raw_path, "sha256": names_sha,
             "supplies": ["tier_b star names"], "layer": "measured"},
        ],
    }


if __name__ == "__main__":
    result = build()
    print(json.dumps({k: v for k, v in result.items()}, indent=2))
