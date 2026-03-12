import { unionFeatures, calcRangeResult } from "./geo";
import * as turf from "@turf/turf";
import type { FeatureCollection } from "geojson";

export interface GeoWorkerRequest {
  lng: number;
  lat: number;
  geojson: FeatureCollection;
}

export interface GeoWorkerResponse {
  distanceKm: number;
  nearest: [number, number] | null;
}

self.onmessage = (e: MessageEvent<GeoWorkerRequest>) => {
  const { lng, lat, geojson } = e.data;
  const point = turf.point([lng, lat]);
  const unified = unionFeatures(geojson);
  if (!unified) {
    self.postMessage({ distanceKm: 0, nearest: null } satisfies GeoWorkerResponse);
    return;
  }
  const result = calcRangeResult(point, unified);
  self.postMessage(result satisfies GeoWorkerResponse);
};
