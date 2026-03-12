#!/usr/bin/env python3
"""Fetch correct iNaturalist taxon IDs for bird species and verify range maps exist."""

import json
import urllib.request
import urllib.parse
import time
import sys

RANGE_BASE = "https://inaturalist-open-data.s3.us-east-1.amazonaws.com/geomodel/geojsons/latest"
SEARCH_API = "https://api.inaturalist.org/v1/taxa"

BIRDS = [
    "American Robin",
    "Bald Eagle",
    "Northern Cardinal",
    "Blue Jay",
    "Red-tailed Hawk",
    "Great Blue Heron",
    "American Goldfinch",
    "Downy Woodpecker",
    "Black-capped Chickadee",
    "European Starling",
    "House Sparrow",
    "Mourning Dove",
    "American Crow",
    "Ruby-throated Hummingbird",
    "Barn Swallow",
    "Song Sparrow",
    "Red-winged Blackbird",
    "White-breasted Nuthatch",
    "Cedar Waxwing",
    "Eastern Bluebird",
    "Osprey",
    "Peregrine Falcon",
    "Snowy Owl",
    "Pileated Woodpecker",
    "Common Loon",
    "Atlantic Puffin",
    "Scarlet Tanager",
    "Belted Kingfisher",
    "Great Horned Owl",
    "Wood Duck",
    "Painted Bunting",
    "Roseate Spoonbill",
    "California Condor",
    "Resplendent Quetzal",
    "Superb Fairywren",
    "European Robin",
    "Eurasian Blue Tit",
    "Indian Peafowl",
    "Laughing Kookaburra",
    "Toco Toucan",
    "Andean Condor",
    "Shoebill",
    "Secretary Bird",
    "Mandarin Duck",
    "Common Kingfisher",
    "Golden Eagle",
    "Barn Owl",
    "Anna's Hummingbird",
    "Greater Roadrunner",
    "Bohemian Waxwing",
]


def search_taxon(name):
    """Search iNaturalist API for a bird by common name."""
    params = urllib.parse.urlencode({"q": name, "rank": "species", "iconic_taxa": "Aves", "per_page": 5})
    url = f"{SEARCH_API}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "GeoBirdr/1.0"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())

    for result in data.get("results", []):
        preferred = result.get("preferred_common_name", "").lower()
        if preferred == name.lower():
            return result["id"], result["name"]

    # Fall back to first bird result
    if data.get("results"):
        r = data["results"][0]
        return r["id"], r["name"]

    return None, None


def has_range_map(taxon_id):
    """Check if a range map GeoJSON exists for this taxon."""
    url = f"{RANGE_BASE}/{taxon_id}.geojson"
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "GeoBirdr/1.0"})
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status == 200
    except urllib.error.HTTPError:
        return False


def main():
    results = []
    skipped = []

    for name in BIRDS:
        taxon_id, scientific = search_taxon(name)
        if not taxon_id:
            print(f"  SKIP {name}: not found on iNaturalist", file=sys.stderr)
            skipped.append(name)
            time.sleep(1)
            continue

        if has_range_map(taxon_id):
            print(f"  OK   {name} -> {taxon_id} ({scientific})", file=sys.stderr)
            results.append({"name": name, "taxonId": taxon_id})
        else:
            print(f"  SKIP {name} -> {taxon_id} ({scientific}): no range map", file=sys.stderr)
            skipped.append(name)

        time.sleep(0.5)  # rate limit

    print(json.dumps(results, indent=2))

    if skipped:
        print(f"\nSkipped {len(skipped)} birds: {', '.join(skipped)}", file=sys.stderr)


if __name__ == "__main__":
    main()
