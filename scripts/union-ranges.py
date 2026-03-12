#!/usr/bin/env python3
"""Union all features in each range GeoJSON file into a single geometry."""

import json
import os
import sys

from shapely.geometry import shape, mapping
from shapely.ops import unary_union

RANGES_DIR = os.path.join(os.path.dirname(__file__), "..", "ranges")


def union_geojson(filepath: str) -> bool:
    """Union all features in a GeoJSON file. Returns True if modified."""
    with open(filepath) as f:
        data = json.load(f)

    features = data.get("features", [])
    if len(features) <= 1:
        return False

    geometries = [shape(feat["geometry"]) for feat in features]
    merged = unary_union(geometries)

    data["features"] = [
        {
            "type": "Feature",
            "properties": {},
            "geometry": json.loads(json.dumps(mapping(merged))),
        }
    ]

    with open(filepath, "w") as f:
        json.dump(data, f)

    return True


def main():
    files = sorted(f for f in os.listdir(RANGES_DIR) if f.endswith(".geojson"))
    modified = 0
    for i, filename in enumerate(files):
        filepath = os.path.join(RANGES_DIR, filename)
        if union_geojson(filepath):
            modified += 1
        if (i + 1) % 500 == 0:
            print(f"Processed {i + 1}/{len(files)}...")

    print(f"Done. Modified {modified}/{len(files)} files.")


if __name__ == "__main__":
    main()
