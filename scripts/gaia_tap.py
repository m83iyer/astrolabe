#!/usr/bin/env python3
"""Shared TAP client for Gaia (ESA) and VizieR async/sync ADQL queries.

Used by build_tier_b.py and build_tier_c.py. Implements the IVOA UWS async
job protocol (submit -> poll phase -> fetch result) since sync queries on
both services truncate at ~5000-20000 rows, far below what Tier B/C need.

No new coordinate math lives here -- this is pure HTTP/ADQL plumbing.
"""
import time
import sys
import csv
import io
import urllib.request
import urllib.parse
import urllib.error

GAIA_TAP_BASE = "https://gea.esac.esa.int/tap-server/tap"
VIZIER_TAP_BASE = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap"


def _post_form(url, data, timeout=60):
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    return urllib.request.urlopen(req, timeout=timeout)


def tap_sync_query(query, base=GAIA_TAP_BASE, fmt="csv", timeout=60):
    """Small/quick ADQL query via TAP sync endpoint. Truncates at the
    service's row cap (Gaia: 2000 default / configurable up to a service
    max; VizieR similar) -- only use for COUNT(*), schema checks, or
    known-small result sets."""
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": fmt, "QUERY": query}
    url = base + "/sync?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def tap_async_query(query, base=GAIA_TAP_BASE, fmt="csv", poll_interval=15,
                     max_wait=1800, log=print):
    """Full ADQL query via the TAP async (UWS) job protocol -- no row cap.
    Submits with PHASE=RUN, polls /phase until COMPLETED/ERROR/ABORTED,
    then fetches /results/result. Returns the raw result body (str)."""
    submit_url = base + "/async"
    data = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": fmt,
            "QUERY": query, "PHASE": "RUN"}
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(submit_url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        resp = opener.open(req, timeout=60)
        # Some TAP servers answer 200 with the job doc instead of a redirect;
        # job id must then be parsed from the body (uncommon) -- treat as error.
        raise RuntimeError(f"expected redirect to job URL, got {resp.status}")
    except urllib.error.HTTPError as e:
        if e.code not in (303, 302):
            raise RuntimeError(f"job submission failed: HTTP {e.code} {e.read()[:500]!r}")
        job_url = e.headers.get("Location")
        if not job_url:
            raise RuntimeError("job submission redirected but no Location header")

    log(f"    [tap] job submitted: {job_url}")
    phase_url = job_url + "/phase"
    t0 = time.time()
    phase = None
    while True:
        with urllib.request.urlopen(phase_url, timeout=30) as resp:
            phase = resp.read().decode("utf-8").strip()
        elapsed = time.time() - t0
        log(f"    [tap] phase={phase} (t={elapsed:.0f}s)")
        if phase in ("COMPLETED", "ERROR", "ABORTED"):
            break
        if elapsed > max_wait:
            raise TimeoutError(f"TAP async job exceeded max_wait={max_wait}s (last phase={phase})")
        time.sleep(poll_interval)

    if phase != "COMPLETED":
        # fetch error detail if present
        try:
            with urllib.request.urlopen(job_url + "/error", timeout=30) as resp:
                detail = resp.read().decode("utf-8")[:2000]
        except Exception:
            detail = "(no error detail available)"
        raise RuntimeError(f"TAP async job ended in phase={phase}: {detail}")

    result_url = job_url + "/results/result"
    with urllib.request.urlopen(result_url, timeout=300) as resp:
        return resp.read().decode("utf-8")


def csv_to_rows(csv_text):
    """Parse CSV text (as returned by FORMAT=csv) into a list of dicts."""
    return list(csv.DictReader(io.StringIO(csv_text)))


if __name__ == "__main__":
    # Minimal smoke test: sync COUNT query against Gaia TAP.
    out = tap_sync_query("SELECT COUNT(*) AS n FROM external.gaiaedr3_gcns_main_1")
    print(out)
