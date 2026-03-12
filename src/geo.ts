import * as turf from "@turf/turf";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  Point,
  Position,
} from "geojson";

type AnyFeature = Feature<Geometry, GeoJsonProperties>;

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

export function calcDistanceToRange(
  point: Feature<Point>,
  geojson: FeatureCollection
): number {
  const features = geojson.features;
  const pts = pointVariants(point);

  for (const feature of features) {
    if (!feature.geometry) continue;
    if (
      feature.geometry.type !== "Polygon" &&
      feature.geometry.type !== "MultiPolygon"
    )
      continue;
    const variants = featureVariants(feature);
    for (const pt of pts) {
      for (const v of variants) {
        try {
          if (turf.booleanPointInPolygon(pt as never, v as never)) return 0;
        } catch {
          /* skip */
        }
      }
    }
  }

  let minDist = Infinity;
  for (const feature of features) {
    if (!feature.geometry) continue;
    const variants = featureVariants(feature);
    for (const v of variants) {
      for (const pt of pts) {
        try {
          const dist = turf.pointToPolygonDistance(pt as never, v as never, {
            units: "kilometers",
          });
          if (dist < minDist) minDist = dist;
        } catch {
          try {
            const line = turf.polygonToLine(v as never);
            const nearest = turf.nearestPointOnLine(
              line as never,
              pt as never,
              { units: "kilometers" }
            );
            if (nearest.properties.dist! < minDist)
              minDist = nearest.properties.dist!;
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  return minDist === Infinity ? 0 : minDist;
}

export function findNearestPointOnRange(
  point: Feature<Point>,
  geojson: FeatureCollection
): [number, number] | null {
  const features = geojson.features;
  const pts = pointVariants(point);

  for (const feature of features) {
    if (!feature.geometry) continue;
    if (
      feature.geometry.type !== "Polygon" &&
      feature.geometry.type !== "MultiPolygon"
    )
      continue;
    const variants = featureVariants(feature);
    for (const pt of pts) {
      for (const v of variants) {
        try {
          if (turf.booleanPointInPolygon(pt as never, v as never)) return null;
        } catch {
          /* skip */
        }
      }
    }
  }

  let minDist = Infinity;
  let closestPt: [number, number] | null = null;

  for (const feature of features) {
    if (!feature.geometry) continue;
    const variants = featureVariants(feature);
    for (const v of variants) {
      for (const pt of pts) {
        try {
          const line = turf.polygonToLine(v as never);
          const nearest = turf.nearestPointOnLine(
            line as never,
            pt as never,
            { units: "kilometers" }
          );
          if (nearest.properties.dist! < minDist) {
            minDist = nearest.properties.dist!;
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
  }
  return closestPt;
}
