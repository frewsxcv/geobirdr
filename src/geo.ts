import * as turf from "@turf/turf";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";

type AnyFeature = Feature<Geometry, GeoJsonProperties>;
type PolyFeature = Feature<Polygon | MultiPolygon>;

function shiftCoords(coords: unknown, offset: number): unknown {
  if (typeof (coords as Position)[0] === "number") {
    const c = coords as Position;
    return [c[0] + offset, c[1]];
  }
  return (coords as unknown[]).map((c) => shiftCoords(c, offset));
}

function shiftFeature(feature: AnyFeature, offset: number): AnyFeature {
  if (offset === 0) return feature;
  const geom = feature.geometry;
  return {
    ...feature,
    geometry: {
      ...geom,
      coordinates: shiftCoords(
        (geom as { coordinates: unknown }).coordinates,
        offset
      ),
    } as Geometry,
  };
}

function crossesDateLine(feature: AnyFeature): boolean {
  const geom = feature.geometry;
  if (!geom) return false;
  let minLon = Infinity;
  let maxLon = -Infinity;
  turf.coordEach(feature, (coord) => {
    if (coord[0] < minLon) minLon = coord[0];
    if (coord[0] > maxLon) maxLon = coord[0];
  });
  return maxLon - minLon > 180;
}

function featureVariants(feature: AnyFeature): AnyFeature[] {
  const variants = [feature];
  if (crossesDateLine(feature)) {
    variants.push(shiftFeature(feature, 360));
  }
  variants.push(shiftFeature(feature, 360));
  variants.push(shiftFeature(feature, -360));
  return variants;
}

function pointVariants(point: Feature<Point>): Feature<Point>[] {
  const [lng, lat] = turf.getCoord(point);
  return [point, turf.point([lng + 360, lat]), turf.point([lng - 360, lat])];
}

export function unionFeatures(geojson: FeatureCollection): PolyFeature | null {
  const polys: PolyFeature[] = [];
  for (const f of geojson.features) {
    if (!f.geometry) continue;
    if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
      polys.push(f as PolyFeature);
    }
  }
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];

  let merged: PolyFeature = polys[0];
  for (let i = 1; i < polys.length; i++) {
    try {
      const result = turf.union(
        turf.featureCollection([merged, polys[i]])
      );
      if (result) merged = result as PolyFeature;
    } catch {
      // If union fails (e.g. non-overlapping with topology issues), keep current merged
    }
  }
  return merged;
}

export interface RangeResult {
  distanceKm: number;
  nearest: [number, number] | null;
}

export function calcRangeResult(
  point: Feature<Point>,
  unified: PolyFeature
): RangeResult {
  const variants = featureVariants(unified);
  const pts = pointVariants(point);

  // Check if point is inside range
  for (const pt of pts) {
    for (const v of variants) {
      try {
        if (turf.booleanPointInPolygon(pt as never, v as never)) {
          return { distanceKm: 0, nearest: null };
        }
      } catch {
        /* skip */
      }
    }
  }

  // Find nearest point and distance in one pass
  let minDist = Infinity;
  let closestPt: [number, number] | null = null;

  for (const v of variants) {
    for (const pt of pts) {
      try {
        const line = turf.polygonToLine(v as never);
        const nearest = turf.nearestPointOnLine(
          line as never,
          pt as never,
          { units: "kilometers" }
        );
        const dist = nearest.properties.dist!;
        if (dist < minDist) {
          minDist = dist;
          let lon = nearest.geometry.coordinates[0] % 360;
          if (lon > 180) lon -= 360;
          if (lon < -180) lon += 360;
          closestPt = [lon, nearest.geometry.coordinates[1]];
        }
      } catch {
        /* skip */
      }
    }
  }

  return {
    distanceKm: minDist === Infinity ? 0 : minDist,
    nearest: closestPt,
  };
}
