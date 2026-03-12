import { GCS_BASE, RANGES_URL, TAXA_API } from "./constants";
import type { Bird } from "./types";
import type { FeatureCollection } from "geojson";

export async function fetchBirds(): Promise<Bird[]> {
  const resp = await fetch(`${GCS_BASE}/birds-ebird.json`);
  return resp.json();
}

export async function fetchRange(speciesCode: string): Promise<FeatureCollection> {
  const resp = await fetch(`${RANGES_URL}/${speciesCode}.geojson`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export interface BirdPhoto {
  url: string;
  attribution: string;
}

export async function fetchBirdPhoto(
  scientificName: string
): Promise<BirdPhoto | null> {
  try {
    const resp = await fetch(
      `${TAXA_API}?q=${encodeURIComponent(scientificName)}&rank=species&per_page=1`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const photo = data.results?.[0]?.default_photo;
    if (!photo) return null;
    const url = photo.medium_url || photo.url;
    if (!url) return null;
    return {
      url,
      attribution: photo.attribution_name || photo.attribution || "",
    };
  } catch {
    return null;
  }
}
