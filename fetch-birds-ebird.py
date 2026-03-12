#!/usr/bin/env python3
"""Fetch bird species with eBird Status & Trends range data.

Downloads smoothed 27km range GeoPackages from eBird S&T API,
computes range area, and outputs birds.json.

Requirements: pip install fiona shapely pyproj
Usage: EBIRD_ST_KEY=your_key python3 fetch-birds-ebird.py > birds.json
"""

import fiona
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pyproj import Geod
from shapely.geometry import shape

EBIRD_ST_KEY = os.environ.get("EBIRD_ST_KEY", "")
ST_BASE = "https://st-download.ebird.org/v1"
TAXONOMY_URL = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&cat=species"

geod = Geod(ellps="WGS84")


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "GeoBirdr/1.0"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def get_taxonomy():
    """Get all bird species from eBird taxonomy."""
    data = fetch_json(TAXONOMY_URL)
    birds = {}
    for sp in data:
        if sp.get("category") == "species":
            birds[sp["speciesCode"]] = {
                "name": sp["comName"],
                "scientificName": sp["sciName"],
            }
    return birds


def check_species(code):
    """Check if a species has S&T range data. Returns code if yes, None if no."""
    url = f"{ST_BASE}/list-obj/2023/{code}?key={EBIRD_ST_KEY}"
    try:
        data = fetch_json(url)
        if any("range_smooth_27km" in f for f in data):
            return code
    except (urllib.error.HTTPError, Exception):
        pass
    return None


def download_range_gpkg(species_code):
    """Download the smoothed 27km range GeoPackage. Returns temp path or None."""
    obj_key = f"2023/{species_code}/ranges/{species_code}_range_smooth_27km_2023.gpkg"
    url = f"{ST_BASE}/fetch?objKey={urllib.parse.quote(obj_key, safe='')}&key={EBIRD_ST_KEY}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "GeoBirdr/1.0"})
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
        tmp = tempfile.NamedTemporaryFile(suffix=".gpkg", delete=False)
        tmp.write(data)
        tmp.close()
        return tmp.name
    except Exception:
        return None


def process_range(gpkg_path, species_code, ranges_dir):
    """Calculate area and write GeoJSON. Returns area in km²."""
    from shapely.geometry import mapping

    features = []
    total_area = 0
    with fiona.open(gpkg_path) as src:
        for f in src:
            shp = shape(f["geometry"])
            total_area += abs(geod.geometry_area_perimeter(shp)[0])
            features.append({
                "type": "Feature",
                "properties": {"season": f["properties"]["season"]},
                "geometry": mapping(shp),
            })

    # Write GeoJSON with reduced precision (~11m accuracy)
    geojson = {"type": "FeatureCollection", "features": features}
    text = json.dumps(geojson)
    text = re.sub(r"(\d+\.\d{4})\d+", r"\1", text)

    os.makedirs(ranges_dir, exist_ok=True)
    with open(os.path.join(ranges_dir, f"{species_code}.geojson"), "w") as f:
        f.write(text)

    return round(total_area / 1e6)


def main():
    if not EBIRD_ST_KEY:
        print("Error: set EBIRD_ST_KEY environment variable", file=sys.stderr)
        sys.exit(1)

    # Step 1: Get taxonomy
    print("Fetching eBird taxonomy...", file=sys.stderr)
    taxonomy = get_taxonomy()
    codes = list(taxonomy.keys())
    print(f"  {len(codes)} bird species", file=sys.stderr)

    # Step 2: Find species with range data (parallelized)
    print("Checking for Status & Trends range data...", file=sys.stderr)
    species_with_ranges = []
    done = 0

    with ThreadPoolExecutor(max_workers=10) as pool:
        for result in pool.map(check_species, codes):
            done += 1
            if result:
                species_with_ranges.append(result)
            if done % 200 == 0:
                print(f"\r  {done}/{len(codes)} checked, {len(species_with_ranges)} with ranges", end="", file=sys.stderr)

    print(f"\n  Found {len(species_with_ranges)} species with range data", file=sys.stderr)

    # Step 3: Download ranges, convert to GeoJSON, and compute areas
    ranges_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ranges")
    print(f"Downloading ranges to {ranges_dir}...", file=sys.stderr)
    results = []

    for i, code in enumerate(species_with_ranges):
        info = taxonomy[code]
        gpkg_path = download_range_gpkg(code)

        if gpkg_path:
            try:
                area = process_range(gpkg_path, code, ranges_dir)
                results.append({
                    "name": info["name"],
                    "scientificName": info["scientificName"],
                    "speciesCode": code,
                    "areaKm2": area,
                })
                if (i + 1) % 10 == 0:
                    print(f"\r  [{i+1}/{len(species_with_ranges)}] {info['name']}: {area:,} km²   ", end="", file=sys.stderr)
            except Exception as e:
                print(f"\n  [{i+1}] {info['name']}: ERROR {e}", file=sys.stderr)
            finally:
                os.unlink(gpkg_path)
        else:
            print(f"\n  [{i+1}] {info['name']}: download failed", file=sys.stderr)

    results.sort(key=lambda x: x["name"])
    print(f"\n\nOutput: {len(results)} birds", file=sys.stderr)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
