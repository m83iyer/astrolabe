#!/usr/bin/env python3
"""Single source of truth for ICRS -> Galactic -> Galactocentric coordinate
conversion. Both the data pipeline and oracle_frames.py import this — never
duplicate this math (see DATA_SCHEMA.md).

Derived from the three defining angles (not a pasted-in rotation matrix,
so every step is auditable): the ICRS position of the North Galactic Pole
(alpha_NGP, delta_NGP) and the galactic longitude of the North Celestial
Pole (l_NCP) — the IAU 1958 / Hipparcos-refined definition used by ESA's
Hipparcos and Gaia archives alike.
"""
import numpy as np

# IAU-defined galactic pole in ICRS (J2000), and the galactic longitude of
# the north celestial pole. These three numbers fully define the frame;
# everything else below is derived, not asserted.
ALPHA_NGP_DEG = 192.85948
DELTA_NGP_DEG = 27.12825
L_NCP_DEG = 122.93192

SUN_GALACTOCENTRIC_PC = np.array([-8150.0, 0.0, 20.8])  # Reid+2019 R0; Bennett & Bovy 2019 z_sun


def icrs_to_xyz(ra_deg, dec_deg):
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    return np.array([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])


def xyz_to_lb(v):
    x, y, z = v
    l = np.degrees(np.arctan2(y, x)) % 360
    b = np.degrees(np.arcsin(np.clip(z, -1, 1)))
    return l, b


def _rotate_around_axis(v, axis, deg):
    """Rodrigues' rotation formula: rotate vector v by `deg` around unit
    vector `axis` (right-hand rule). Used instead of chained elementary
    (x/y/z) rotations, which are easy to get subtly wrong in ordering or
    sign — this form is directly traceable to one geometric statement per
    step, each independently checkable."""
    a = np.radians(deg)
    axis = axis / np.linalg.norm(axis)
    return (v * np.cos(a)
            + np.cross(axis, v) * np.sin(a)
            + axis * np.dot(axis, v) * (1 - np.cos(a)))


def icrs_to_galactic_matrix():
    """Build the ICRS->Galactic rotation from exactly the three defining
    geometric statements, each a single checkable step:
      1. Galactic north (z_gal) is the ICRS direction of the NGP.
      2. The ICRS North Celestial Pole (0,0,1) has galactic longitude
         L_NCP -- i.e. its projection onto the galactic plane sits at
         angle L_NCP from galactic x (measured toward galactic y).
      3. x_gal, y_gal, z_gal form a right-handed orthonormal frame.
    Statement 2 is solved directly: project NCP onto the plane
    perpendicular to z_gal, then rotate that projection by -L_NCP around
    z_gal to recover x_gal (undoing the L_NCP rotation that would produce
    the NCP's projection from x_gal in the first place)."""
    z_gal = icrs_to_xyz(ALPHA_NGP_DEG, DELTA_NGP_DEG)

    ncp = np.array([0.0, 0.0, 1.0])
    ncp_perp = ncp - np.dot(ncp, z_gal) * z_gal
    ncp_perp /= np.linalg.norm(ncp_perp)

    x_gal = _rotate_around_axis(ncp_perp, z_gal, -L_NCP_DEG)
    x_gal /= np.linalg.norm(x_gal)
    y_gal = np.cross(z_gal, x_gal)

    # Rows = new basis vectors expressed in ICRS xyz, so R @ v_icrs gives
    # v's components along (x_gal, y_gal, z_gal).
    return np.array([x_gal, y_gal, z_gal])


_R = icrs_to_galactic_matrix()


def icrs_to_galactic_lb(ra_deg, dec_deg):
    """ICRS (ra, dec) in degrees -> Galactic (l, b) in degrees."""
    v_icrs = icrs_to_xyz(ra_deg, dec_deg)
    v_gal = _R @ v_icrs
    return xyz_to_lb(v_gal)


def galactic_to_galactocentric_pc(l_deg, b_deg, dist_pc):
    """Galactic (l, b, distance) -> Galactocentric Cartesian, pc.
    Heliocentric galactic XYZ (x toward GC at l=0,b=0), then shifted so the
    Sun sits at SUN_GALACTOCENTRIC_PC and the Galactic Center is the origin."""
    l, b = np.radians(l_deg), np.radians(b_deg)
    x_helio = dist_pc * np.cos(b) * np.cos(l)
    y_helio = dist_pc * np.cos(b) * np.sin(l)
    z_helio = dist_pc * np.sin(b)
    return SUN_GALACTOCENTRIC_PC + np.array([x_helio, y_helio, z_helio])


def icrs_to_galactocentric_pc(ra_deg, dec_deg, dist_pc):
    l, b = icrs_to_galactic_lb(ra_deg, dec_deg)
    return galactic_to_galactocentric_pc(l, b, dist_pc)


if __name__ == "__main__":
    # Self-check against a well-established invariant: Sagittarius A* (the
    # Galactic Center)'s real ICRS position must map to l~0, b~0 by the very
    # definition of galactic coordinates' origin — Reid & Brunthaler 2004,
    # RA=17h45m40.0409s Dec=-29d00m28.118s.
    sgr_a_ra = (17 + 45/60 + 40.0409/3600) * 15
    sgr_a_dec = -(29 + 0/60 + 28.118/3600)
    l, b = icrs_to_galactic_lb(sgr_a_ra, sgr_a_dec)
    print(f"Sgr A* (real ICRS {sgr_a_ra:.4f}, {sgr_a_dec:.4f}) -> l={l:.4f} deg, b={b:.4f} deg  (expect ~0, ~0)")
    assert abs((l + 180) % 360 - 180) < 0.2 and abs(b) < 0.2, "Galactic Center does not map to l~0,b~0 — frame is wrong"

    # NGP round-trip: the pole itself must map to b=90.
    l2, b2 = icrs_to_galactic_lb(ALPHA_NGP_DEG, DELTA_NGP_DEG)
    print(f"NGP -> l={l2:.4f} deg (undefined at pole), b={b2:.4f} deg (expect ~90)")
    assert abs(b2 - 90) < 1e-6, "NGP does not map to b=90 — frame is wrong"

    # Sun's own position by definition: at the origin in heliocentric terms,
    # must land exactly on SUN_GALACTOCENTRIC_PC.
    sun_check = galactic_to_galactocentric_pc(0, 0, 0)
    print(f"Sun (0 pc from itself) -> {sun_check} pc  (expect {SUN_GALACTOCENTRIC_PC})")
    assert np.allclose(sun_check, SUN_GALACTOCENTRIC_PC)

    # Galactic Center distance check: at l=0,b=0, distance=8150pc should
    # land exactly on the origin (0,0,0) plus the z_sun offset error term —
    # z stays at +20.8 since b=0 contributes no z, matching the definition
    # that the Sun's height is a fixed offset, not corrected by direction.
    gc_check = galactic_to_galactocentric_pc(0, 0, 8150)
    print(f"GC (8150 pc at l=0,b=0) -> {gc_check} pc  (expect close to [0,0,20.8])")
    assert abs(gc_check[0]) < 1 and abs(gc_check[1]) < 1

    print("\nAll frame self-checks passed.")
