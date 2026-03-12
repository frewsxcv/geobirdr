#!/usr/bin/env python3
"""Fetch all bird species with available iNaturalist range maps.

Downloads the iNaturalist bird geopackage files, extracts taxon IDs and
scientific names, then looks up common names via the iNaturalist API.
Outputs birds.json with all birds that have range maps available.

Requirements: pip install fiona
"""

import fiona
import json
import sys
import tempfile
import time
import urllib.parse
import urllib.request

GPKG_BASE = "https://inaturalist-open-data.s3.us-east-1.amazonaws.com/geomodel/geopackages/latest"
METADATA_URL = f"{GPKG_BASE}/metadata.json"
TAXA_API = "https://api.inaturalist.org/v1/taxa"
HEADERS = {"User-Agent": "GeoBirdr/1.0"}


def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def get_num_archives():
    """Get the number of bird geopackage archives from metadata."""
    metadata = fetch_json(METADATA_URL)
    return metadata["collections"]["Aves"]["archives"]


def download_file(url, path):
    """Download a file with progress."""
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        with open(path, "wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded * 100 // total
                    print(f"\r  Downloading... {pct}% ({downloaded // 1024 // 1024}/{total // 1024 // 1024} MB)", end="", file=sys.stderr)
        print(file=sys.stderr)


def extract_taxa_from_gpkg(path):
    """Extract taxon_id and scientific name from a geopackage (ignoring geometry)."""
    taxa = {}
    with fiona.open(path) as src:
        for feature in src:
            props = feature["properties"]
            taxon_id = props.get("taxon_id")
            name = props.get("name", "")
            if taxon_id:
                taxa[taxon_id] = name
    return taxa


def lookup_common_names(taxon_ids):
    """Look up common names for taxon IDs via the iNaturalist API (30 at a time)."""
    common_names = {}
    batch_size = 30
    ids = list(taxon_ids)

    for i in range(0, len(ids), batch_size):
        batch = ids[i:i + batch_size]
        params = urllib.parse.urlencode({"id": ",".join(str(x) for x in batch), "per_page": batch_size})
        url = f"{TAXA_API}?{params}"

        try:
            data = fetch_json(url)
            for result in data.get("results", []):
                tid = result["id"]
                common = result.get("preferred_common_name", "")
                if common:
                    common_names[tid] = common
        except Exception as e:
            print(f"  Warning: API error for batch starting at {i}: {e}", file=sys.stderr)

        if i + batch_size < len(ids):
            time.sleep(1)  # rate limit

        done = min(i + batch_size, len(ids))
        print(f"\r  Looking up common names... {done}/{len(ids)}", end="", file=sys.stderr)

    print(file=sys.stderr)
    return common_names


def main():
    num_archives = get_num_archives()
    print(f"Found {num_archives} bird geopackage archive(s)", file=sys.stderr)

    # Download and extract taxa from each geopackage
    all_taxa = {}
    for i in range(1, num_archives + 1):
        url = f"{GPKG_BASE}/iNaturalist_geomodel_Aves_{i}.gpkg"
        print(f"Downloading Aves_{i}.gpkg...", file=sys.stderr)

        with tempfile.NamedTemporaryFile(suffix=".gpkg", delete=True) as tmp:
            download_file(url, tmp.name)
            print(f"  Extracting taxa...", file=sys.stderr)
            taxa = extract_taxa_from_gpkg(tmp.name)
            print(f"  Found {len(taxa)} species", file=sys.stderr)
            all_taxa.update(taxa)

    print(f"\nTotal: {len(all_taxa)} bird species with range maps", file=sys.stderr)

    # Look up common names
    print("Looking up common names from iNaturalist API...", file=sys.stderr)
    common_names = lookup_common_names(all_taxa.keys())
    print(f"Found common names for {len(common_names)}/{len(all_taxa)} species", file=sys.stderr)

    # Build output — only include birds with common names
    results = []
    for taxon_id, scientific_name in sorted(all_taxa.items()):
        common_name = common_names.get(taxon_id)
        if common_name:
            results.append({
                "name": common_name,
                "scientificName": scientific_name,
                "taxonId": taxon_id,
            })

    results.sort(key=lambda x: x["name"])

    print(f"\nOutput: {len(results)} birds with common names and range maps", file=sys.stderr)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
