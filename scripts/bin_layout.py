#!/usr/bin/env python3
"""Shared struct-of-arrays binary writer for Tier B/C star catalogs.

Each column is a separate contiguous typed-array block inside one flat
.bin file (struct-of-arrays, not array-of-structs) so a WebGL renderer can
read each field straight into a Float32Array/BigInt64Array/Uint8Array with
zero per-row parsing. Every block starts at an 8-byte-aligned offset
(covers the alignment needs of all dtypes used here, including int64/
float64) and the exact offsets are written into the accompanying
meta.json -- the renderer never has to compute layout, only read it.
"""
import json
import numpy as np

_DTYPE_INFO = {
    "float32": (np.float32, "Float32Array"),
    "int64": (np.int64, "BigInt64Array"),
    "uint8": (np.uint8, "Uint8Array"),
}


def _pad8(n):
    return (8 - (n % 8)) % 8


def write_soa_binary(bin_path, columns):
    """columns: list of (name, dtype_str, numpy_array, notes_or_None).
    Writes bin_path and returns the list of column descriptors (dicts) for
    embedding in the meta.json 'columns' field."""
    descriptors = []
    blocks = []
    offset = 0
    n_rows = None
    for name, dtype_str, arr, notes in columns:
        if dtype_str not in _DTYPE_INFO:
            raise ValueError(f"unsupported dtype {dtype_str!r} for column {name!r}")
        np_dtype, js_type = _DTYPE_INFO[dtype_str]
        arr = np.ascontiguousarray(arr, dtype=np_dtype)
        if n_rows is None:
            n_rows = len(arr)
        elif len(arr) != n_rows:
            raise ValueError(f"column {name!r} has {len(arr)} rows, expected {n_rows}")
        pad = _pad8(offset)
        offset += pad
        byte_length = arr.nbytes
        desc = {
            "name": name,
            "dtype": dtype_str,
            "js_typed_array": js_type,
            "count": int(n_rows),
            "byte_offset": int(offset),
            "byte_length": int(byte_length),
        }
        if notes:
            desc["notes"] = notes
        descriptors.append(desc)
        blocks.append((pad, arr))
        offset += byte_length

    with open(bin_path, "wb") as f:
        for pad, arr in blocks:
            if pad:
                f.write(b"\x00" * pad)
            f.write(arr.tobytes())

    return descriptors, n_rows, offset


def write_meta_json(meta_path, *, tier, description, row_count, total_bytes,
                     columns, extra=None):
    meta = {
        "tier": tier,
        "description": description,
        "layout": "struct-of-arrays (each column is one contiguous typed-array block; read via byte_offset/byte_length below, no per-row parsing)",
        "row_count": row_count,
        "total_bytes": total_bytes,
        "columns": columns,
    }
    if extra:
        meta.update(extra)
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    return meta
