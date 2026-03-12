import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import * as turf from "@turf/turf";
import type { FeatureCollection } from "geojson";
import { DIFFICULTY, MAX_POINTS } from "./constants";
import { fetchBirds, fetchRange, fetchBirdPhoto } from "./api";
import { calcDistanceToRange, findNearestPointOnRange } from "./geo";
import type { Bird, DifficultyKey, RoundResult } from "./types";

export default function App() {
  const mapRef = useRef<L.Map | null>(null);
  const mapElRef = useRef<HTMLDivElement>(null);
  const allBirdsRef = useRef<Bird[]>([]);
  const birdsRef = useRef<Bird[]>([]);
  const usedBirdsRef = useRef<Set<string>>(new Set());
  const guessAllowedRef = useRef(true);
  const layersRef = useRef<{
    guess: L.Marker | null;
    range: L.GeoJSON | null;
    line: L.Polyline | null;
    nearest: L.CircleMarker | null;
  }>({ guess: null, range: null, line: null, nearest: null });

  const [currentBird, setCurrentBird] = useState<Bird | null>(null);
  const [roundNum, setRoundNum] = useState(1);
  const [totalScore, setTotalScore] = useState(0);
  const [difficulty, setDifficulty] = useState<DifficultyKey>("easy");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [photo, setPhoto] = useState<{ url: string; attribution: string } | null>(null);

  const filterBirds = useCallback((key: DifficultyKey) => {
    const diff = DIFFICULTY[key];
    birdsRef.current = allBirdsRef.current.filter(
      (b) => b.areaKm2 >= diff.min && b.areaKm2 < diff.max
    );
  }, []);

  const pickRandomBird = useCallback((): Bird => {
    const birds = birdsRef.current;
    const used = usedBirdsRef.current;
    if (used.size >= birds.length) used.clear();
    let bird: Bird;
    do {
      bird = birds[Math.floor(Math.random() * birds.length)];
    } while (used.has(bird.speciesCode));
    used.add(bird.speciesCode);
    return bird;
  }, []);

  const clearLayers = useCallback(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map) return;
    if (layers.guess) { map.removeLayer(layers.guess); layers.guess = null; }
    if (layers.range) { map.removeLayer(layers.range); layers.range = null; }
    if (layers.line) { map.removeLayer(layers.line); layers.line = null; }
    if (layers.nearest) { map.removeLayer(layers.nearest); layers.nearest = null; }
  }, []);

  const startRound = useCallback(() => {
    clearLayers();
    setResult(null);
    setLoading(false);
    guessAllowedRef.current = true;

    const bird = pickRandomBird();
    setCurrentBird(bird);
    setPhoto(null);
    mapRef.current?.setView([20, 0], 2);

    fetchBirdPhoto(bird.scientificName).then((p) => {
      if (p) setPhoto(p);
    });
  }, [clearLayers, pickRandomBird]);

  const handleGuess = useCallback(
    async (latlng: L.LatLng) => {
      if (!guessAllowedRef.current || !currentBird) return;
      guessAllowedRef.current = false;

      const map = mapRef.current!;
      const layers = layersRef.current;

      layers.guess = L.marker(latlng, {
        icon: L.divIcon({
          className: "",
          html: '<div style="background:#e63946;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
      }).addTo(map);

      setLoading(true);

      try {
        const geojson: FeatureCollection = await fetchRange(currentBird.speciesCode);
        setLoading(false);

        layers.range = L.geoJSON(geojson, {
          style: {
            color: "#2d6a4f",
            weight: 2,
            fillColor: "#40916c",
            fillOpacity: 0.3,
          },
        }).addTo(map);

        const guessPoint = turf.point([latlng.lng, latlng.lat]);
        const distanceKm = calcDistanceToRange(guessPoint, geojson);
        const nearest = findNearestPointOnRange(guessPoint, geojson);

        if (nearest && distanceKm > 0) {
          let guessLng = latlng.lng;
          let nearLng = nearest[0];
          if (nearLng - guessLng > 180) nearLng -= 360;
          else if (guessLng - nearLng > 180) nearLng += 360;

          layers.line = L.polyline(
            [
              [latlng.lat, guessLng],
              [nearest[1], nearLng],
            ],
            { color: "#e63946", weight: 2, dashArray: "6 4" }
          ).addTo(map);

          layers.nearest = L.circleMarker([nearest[1], nearLng], {
            radius: 6,
            color: "#2d6a4f",
            fillColor: "#40916c",
            fillOpacity: 1,
            weight: 2,
          }).addTo(map);
        }

        const points = Math.max(0, Math.round(MAX_POINTS - distanceKm));
        setTotalScore((prev) => prev + points);
        setResult({ distanceKm, points });

        const bounds = layers.range.getBounds();
        bounds.extend(latlng);
        map.fitBounds(bounds, { padding: [50, 50] });
      } catch (err) {
        setLoading(false);
        console.error("Failed to fetch range:", err);
        alert(
          `Could not load range data for ${currentBird.name}. Skipping...`
        );
        guessAllowedRef.current = true;
        setRoundNum((n) => n + 1);
        startRound();
      }
    },
    [currentBird, startRound]
  );

  // Initialize map and load birds
  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(mapElRef.current!, { worldCopyJump: true }).setView(
      [20, 0],
      2
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);
    mapRef.current = map;

    fetchBirds().then((data) => {
      allBirdsRef.current = data;
      const diff = DIFFICULTY["easy"];
      birdsRef.current = data.filter(
        (b) => b.areaKm2 >= diff.min && b.areaKm2 < diff.max
      );
      // Start first round
      const used = usedBirdsRef.current;
      const birds = birdsRef.current;
      if (used.size >= birds.length) used.clear();
      let bird: Bird;
      do {
        bird = birds[Math.floor(Math.random() * birds.length)];
      } while (used.has(bird.speciesCode));
      used.add(bird.speciesCode);
      setCurrentBird(bird);
      fetchBirdPhoto(bird.scientificName).then((p) => {
        if (p) setPhoto(p);
      });
    });
  }, []);

  // Wire up map click handler
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e: L.LeafletMouseEvent) => handleGuess(e.latlng);
    map.on("click", handler);
    return () => { map.off("click", handler); };
  }, [handleGuess]);

  const handleNextBird = () => {
    setRoundNum((n) => n + 1);
    startRound();
  };

  const handleDifficultyChange = (key: DifficultyKey) => {
    setDifficulty(key);
    filterBirds(key);
    setTotalScore(0);
    setRoundNum(1);
    clearLayers();
    setResult(null);
    setLoading(false);
    guessAllowedRef.current = true;

    const bird = pickRandomBird();
    setCurrentBird(bird);
    setPhoto(null);
    mapRef.current?.setView([20, 0], 2);
    fetchBirdPhoto(bird.scientificName).then((p) => {
      if (p) setPhoto(p);
    });
  };

  return (
    <>
      <div className="header">
        <h1>GeoBirdr</h1>
        <div className="header-right">
          <select
            className="difficulty-select"
            value={difficulty}
            onChange={(e) =>
              handleDifficultyChange(e.target.value as DifficultyKey)
            }
          >
            <option value="all">All Birds</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
            <option value="expert">Expert</option>
          </select>
          <div className="score-display">
            Round: {roundNum} &nbsp;|&nbsp; Score:{" "}
            {totalScore.toLocaleString()}
          </div>
        </div>
      </div>

      <div className="bird-banner">
        <span>
          Where does the <strong>{currentBird?.name ?? "..."}</strong>{" "}
          {currentBird?.scientificName && (
            <em>({currentBird.scientificName})</em>
          )}{" "}
          live?
        </span>
        <span className="instruction">Click on the map to guess</span>
      </div>

      <div className="map-container">
        <div className="map" ref={mapElRef} />

        {photo && (
          <div className="bird-photo">
            <img src={photo.url} alt={currentBird?.name ?? ""} />
            <div className="attribution">{photo.attribution}</div>
          </div>
        )}

        {loading && (
          <div className="loading-overlay">
            <div className="spinner">Fetching range data...</div>
          </div>
        )}

        {result && (
          <div className="result-panel">
            {result.distanceKm === 0 ? (
              <>
                <div className="perfect">Inside the range!</div>
                <div className="distance">0 km</div>
              </>
            ) : (
              <>
                <div>Distance to range:</div>
                <div className="distance">
                  {Math.round(result.distanceKm).toLocaleString()} km
                </div>
              </>
            )}
            <div className="points">
              +{result.points.toLocaleString()} points
            </div>
            <button className="next-btn" onClick={handleNextBird}>
              Next Bird
            </button>
          </div>
        )}
      </div>
    </>
  );
}
