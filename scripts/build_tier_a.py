#!/usr/bin/env python3
"""Build Tier A -- the always-loaded structure layer: measured tracers
(Cepheids, masers, open clusters, globular clusters, landmarks). Model
(spiral-arm/disk) data is a separate script -- this only writes the
`measured` section of app/data/tier_a_structure.json.

Every column name below was verified live against each table's own
metadata before being used here (not guessed) -- two earlier attempts at
this exact task (a fresh agent each time) burned their full turn budget
on trial-and-error against VizieR and produced nothing; the difference
here is every query was checked with a `SELECT TOP 2/3 *` + metadata
dump first.
"""
import hashlib
import json
import re
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames

PROJECT = Path(__file__).resolve().parent.parent
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
SSD_RAW = Path(f"/Volumes/Media/AutomationStore/project-artifacts/astrolabe/{TODAY}/raw-fetches")
DATA_OUT = PROJECT / "app" / "data"
VIZIER_TAP = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"


def vizier_query(query, fmt="json"):
    data = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": fmt, "MAXREC": "20000", "QUERY": query}).encode()
    req = urllib.request.Request(VIZIER_TAP, data=data, method="POST", headers={"User-Agent": "Mozilla/5.0 (astrolabe-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = resp.read()
    return raw


def save_source(raw_bytes, filename, url, supplies, layer="measured"):
    SSD_RAW.mkdir(parents=True, exist_ok=True)
    path = SSD_RAW / filename
    path.write_bytes(raw_bytes)
    sha = hashlib.sha256(raw_bytes).hexdigest()
    return {"url": url, "fetched_utc": datetime.now(timezone.utc).isoformat(), "sha256": sha,
            "local_file": str(path), "supplies": supplies, "layer": layer}


def fetch_cepheids(log=print):
    q = 'SELECT Name, GLON, GLAT, Dist FROM "J/AcA/69/305/table1"'
    raw = vizier_query(q)
    src = save_source(raw, "cepheids.json", VIZIER_TAP + " (J/AcA/69/305/table1)", ["tier_a cepheids"])
    d = json.loads(raw)
    out = []
    for row in d["data"]:
        name, glon, glat, dist = row
        if dist is None or glon is None or glat is None:
            continue
        pc = frames.galactic_to_galactocentric_pc(glon, glat, dist)
        clean_name = re.sub(r"_+", " ", name).strip()  # names are underscore-padded, e.g. "AW____Per"
        out.append({"name": clean_name, "x_pc": round(float(pc[0]), 2),
                     "y_pc": round(float(pc[1]), 2), "z_pc": round(float(pc[2]), 2), "source": "Skowron+2019"})
    log(f"[tier_a] cepheids: {len(out)} rows")
    return out, src


ARM_NAMES = {
    "Per": "Perseus", "Sct-Cen": "Scutum-Centaurus", "Sct": "Scutum-Centaurus", "Cen": "Scutum-Centaurus",
    "Loc": "Local", "Local": "Local", "Sgr": "Sagittarius", "SgN": "Sagittarius", "SgF": "Sagittarius",
    "Nor": "Norma", "Out": "Outer", "Outer": "Outer", "AqR": "Aquila Rift", "CrN": "Carina", "CrF": "Carina",
    "L-C": "Local-Carina", "Con": "Connecting", "Connecting": "Connecting", "Norma": "Norma",
    "ScN": "Scutum-Centaurus", "ScF": "Scutum-Centaurus", "Carina": "Carina", "Sagittarius": "Sagittarius",
    "???": "Unclassified (source doesn't assign this maser to a named arm)",
}
# Codes intentionally left unexpanded (displayed as-is) rather than guessed:
# LoS, AqS, GC, 3kN, 3kF, OSC, CtN -- not confident enough of the exact
# expansion from the query alone to assert one; showing the real catalog
# code is honest, a wrong guessed name would not be.


def fetch_masers(log=print):
    q = 'SELECT Name, RAJ2000, DEJ2000, plx, Arm FROM "J/ApJ/885/131/table1"'
    raw = vizier_query(q)
    src = save_source(raw, "masers.json", VIZIER_TAP + " (J/ApJ/885/131/table1)", ["tier_a masers"])
    d = json.loads(raw)
    out = []
    for row in d["data"]:
        name, ra_h, dec, plx, arm = row
        if plx is None or plx <= 0:
            continue
        ra_deg = ra_h * 15.0  # RAJ2000 is in hours per this table's own metadata
        dist_pc = 1000.0 / plx
        pc = frames.icrs_to_galactocentric_pc(ra_deg, dec, dist_pc)
        arm_code = (arm or "").strip()
        out.append({"name": name, "x_pc": round(float(pc[0]), 2), "y_pc": round(float(pc[1]), 2),
                     "z_pc": round(float(pc[2]), 2), "arm": ARM_NAMES.get(arm_code, arm_code or "unassigned"),
                     "source": "Reid+2019"})
    log(f"[tier_a] masers: {len(out)} rows")
    return out, src


def fetch_open_clusters(log=print):
    q = 'SELECT Name, GLON, GLAT, dist50, Type FROM "J/A+A/673/A114/clusters" WHERE Type=\'o\''
    raw = vizier_query(q)
    src = save_source(raw, "open_clusters.json", VIZIER_TAP + " (J/A+A/673/A114/clusters, Type=o)", ["tier_a open clusters"])
    d = json.loads(raw)
    out = []
    for row in d["data"]:
        name, glon, glat, dist, typ = row
        if dist is None:
            continue
        pc = frames.galactic_to_galactocentric_pc(glon, glat, dist)
        out.append({"name": name, "x_pc": round(float(pc[0]), 2), "y_pc": round(float(pc[1]), 2),
                     "z_pc": round(float(pc[2]), 2), "source": "Hunt & Reffert 2023"})
    log(f"[tier_a] open clusters: {len(out)} rows")
    return out, src


def fetch_globular_clusters(log=print):
    url = "https://people.smp.uq.edu.au/HolgerBaumgardt/globular/orbits_table.txt"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (astrolabe-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    src = save_source(raw, "globular_clusters.txt", url, ["tier_a globular clusters"])
    text = raw.decode("utf-8", errors="replace")
    out = []
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 21:
            continue
        try:
            name = parts[0].replace("_", " ")
            x_kpc, y_kpc, z_kpc = float(parts[15]), float(parts[17]), float(parts[19])
        except ValueError:
            continue
        # This source already publishes Galactocentric X/Y/Z (kpc) directly
        # -- used as-is (x1000 for pc), not re-derived via frames.py, since
        # it's an independent conversion (a useful cross-check target for
        # oracle_frames.py against any of these clusters that also appear
        # elsewhere, though none currently overlap the other tier_a sources).
        out.append({"name": name, "x_pc": round(x_kpc * 1000, 1), "y_pc": round(y_kpc * 1000, 1),
                     "z_pc": round(z_kpc * 1000, 1), "source": "Baumgardt+ orbits DB v4"})
    log(f"[tier_a] globular clusters: {len(out)} rows")
    return out, src


def landmarks():
    sun = frames.SUN_GALACTOCENTRIC_PC
    return [
        {"name": "Sun", "x_pc": float(sun[0]), "y_pc": float(sun[1]), "z_pc": float(sun[2]), "source": "definitional, see scripts/frames.py"},
        {"name": "Sagittarius A∗", "x_pc": 0.0, "y_pc": 0.0, "z_pc": 0.0, "source": "definitional, see scripts/frames.py"},
    ]


def main():
    log = print
    cepheids, src_ceph = fetch_cepheids(log)
    masers, src_maser = fetch_masers(log)
    clusters, src_clusters = fetch_open_clusters(log)
    globulars, src_glob = fetch_globular_clusters(log)
    lms = landmarks()

    structure_path = DATA_OUT / "tier_a_structure.json"
    existing = {}
    if structure_path.exists():
        existing = json.loads(structure_path.read_text())
    measured = {
        "cepheids": cepheids, "masers": masers, "open_clusters": clusters,
        "globular_clusters": globulars, "landmarks": lms,
    }
    out = {"measured": measured, "model": existing.get("model", {})}
    DATA_OUT.mkdir(parents=True, exist_ok=True)
    structure_path.write_text(json.dumps(out, indent=1))

    sources_path = DATA_OUT / "sources.json"
    sources = json.loads(sources_path.read_text()) if sources_path.exists() else []
    for s in (src_ceph, src_maser, src_clusters, src_glob):
        sources = [x for x in sources if x.get("url") != s["url"]]
        sources.append(s)
    sources_path.write_text(json.dumps(sources, indent=1))

    log(f"\n[tier_a] wrote {structure_path}")
    log(f"[tier_a] totals: {len(cepheids)} cepheids, {len(masers)} masers, {len(clusters)} open clusters, {len(globulars)} globular clusters, {len(lms)} landmarks")


if __name__ == "__main__":
    main()
