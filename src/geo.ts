import Flatbush from "flatbush";
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

// --- Coordinate shifting for dateline handling ---

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

// --- Extract all rings from polygons ---

function extractRings(feature: AnyFeature): Position[][] {
  const geom = feature.geometry;
  if (!geom) return [];
  if (geom.type === "Polygon") {
    return (geom as Polygon).coordinates;
  }
  if (geom.type === "MultiPolygon") {
    const rings: Position[][] = [];
    for (const poly of (geom as MultiPolygon).coordinates) {
      for (const ring of poly) {
        rings.push(ring);
      }
    }
    return rings;
  }
  return [];
}

// --- Spatial-indexed nearest point on boundary ---

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function buildSegmentIndex(rings: Position[][]): {
  index: Flatbush;
  segments: Segment[];
} {
  const segments: Segment[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      segments.push({
        ax: ring[i][0],
        ay: ring[i][1],
        bx: ring[i + 1][0],
        by: ring[i + 1][1],
      });
    }
  }

  const index = new Flatbush(segments.length);
  for (const s of segments) {
    index.add(
      Math.min(s.ax, s.bx),
      Math.min(s.ay, s.by),
      Math.max(s.ax, s.bx),
      Math.max(s.ay, s.by)
    );
  }
  index.finish();

  return { index, segments };
}

// Nearest point on a line segment (ax,ay)-(bx,by) from point (px,py)
function nearestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number; distSq: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  }
  const x = ax + t * dx;
  const y = ay + t * dy;
  const ex = px - x;
  const ey = py - y;
  return { x, y, distSq: ex * ex + ey * ey };
}

// Haversine distance in km between two lng/lat points
function haversineKm(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestOnBoundary(
  px: number,
  py: number,
  segIndex: { index: Flatbush; segments: Segment[] }
): { x: number; y: number; distKm: number } | null {
  const { index, segments } = segIndex;

  // Get the 20 nearest segments by bounding-box distance
  const candidates = index.neighbors(px, py, 20);

  let bestDistSq = Infinity;
  let bestX = 0;
  let bestY = 0;

  for (const idx of candidates) {
    const s = segments[idx];
    const { x, y, distSq } = nearestOnSegment(px, py, s.ax, s.ay, s.bx, s.by);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestX = x;
      bestY = y;
    }
  }

  if (bestDistSq === Infinity) return null;

  return {
    x: bestX,
    y: bestY,
    distKm: haversineKm(px, py, bestX, bestY),
  };
}

// --- Public API ---

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
      // If union fails, keep current merged
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
  geojson: FeatureCollection
): RangeResult {
  // Collect all polygon features
  const polyFeatures: AnyFeature[] = [];
  for (const f of geojson.features) {
    if (!f.geometry) continue;
    if (
      f.geometry.type === "Polygon" ||
      f.geometry.type === "MultiPolygon"
    ) {
      polyFeatures.push(f);
    }
  }
  if (polyFeatures.length === 0) return { distanceKm: 0, nearest: null };

  const pts = pointVariants(point);

  // Check if point is inside any polygon
  for (const feature of polyFeatures) {
    const variants = featureVariants(feature);
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
  }

  // Build spatial index over all edges from all features (including dateline variants)
  let bestDistKm = Infinity;
  let bestNearest: [number, number] | null = null;

  for (const feature of polyFeatures) {
    const variants = featureVariants(feature);
    for (const v of variants) {
      const rings = extractRings(v);
      if (rings.length === 0) continue;
      const segIndex = buildSegmentIndex(rings);

      for (const pt of pts) {
        const [px, py] = turf.getCoord(pt);
        const result = findNearestOnBoundary(px, py, segIndex);
        if (result && result.distKm < bestDistKm) {
          bestDistKm = result.distKm;
          let lon = result.x % 360;
          if (lon > 180) lon -= 360;
          if (lon < -180) lon += 360;
          bestNearest = [lon, result.y];
        }
      }
    }
  }

  return {
    distanceKm: bestDistKm === Infinity ? 0 : bestDistKm,
    nearest: bestNearest,
  };
}
