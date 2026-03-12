import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import * as turf from "@turf/turf";
import type { FeatureCollection } from "geojson";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import Backdrop from "@mui/material/Backdrop";
import CircularProgress from "@mui/material/CircularProgress";
import Card from "@mui/material/Card";
import CardMedia from "@mui/material/CardMedia";
import type { SelectChangeEvent } from "@mui/material/Select";
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
  const [photo, setPhoto] = useState<{
    url: string;
    attribution: string;
  } | null>(null);

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
    if (layers.guess) {
      map.removeLayer(layers.guess);
      layers.guess = null;
    }
    if (layers.range) {
      map.removeLayer(layers.range);
      layers.range = null;
    }
    if (layers.line) {
      map.removeLayer(layers.line);
      layers.line = null;
    }
    if (layers.nearest) {
      map.removeLayer(layers.nearest);
      layers.nearest = null;
    }
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
        const geojson: FeatureCollection = await fetchRange(
          currentBird.speciesCode
        );
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
    return () => {
      map.off("click", handler);
    };
  }, [handleGuess]);

  const handleNextBird = () => {
    setRoundNum((n) => n + 1);
    startRound();
  };

  const handleDifficultyChange = (e: SelectChangeEvent) => {
    const key = e.target.value as DifficultyKey;
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
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Header */}
      <AppBar position="static" sx={{ bgcolor: "primary.main", zIndex: 1000 }}>
        <Toolbar sx={{ justifyContent: "space-between" }}>
          <Typography variant="h6" sx={{ letterSpacing: 1 }}>
            GeoBirdr
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Select
              value={difficulty}
              onChange={handleDifficultyChange}
              size="small"
              sx={{
                color: "white",
                fontSize: "0.85rem",
                bgcolor: "rgba(255,255,255,0.15)",
                border: "1px solid rgba(255,255,255,0.3)",
                borderRadius: 1.5,
                "& .MuiSelect-icon": { color: "white" },
                "& .MuiOutlinedInput-notchedOutline": { border: "none" },
              }}
            >
              <MenuItem value="all">All Birds</MenuItem>
              <MenuItem value="easy">Easy</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="hard">Hard</MenuItem>
              <MenuItem value="expert">Expert</MenuItem>
            </Select>
            <Typography variant="body1" sx={{ opacity: 0.9 }}>
              Round: {roundNum} &nbsp;|&nbsp; Score:{" "}
              {totalScore.toLocaleString()}
            </Typography>
          </Box>
        </Toolbar>
      </AppBar>

      {/* Bird Banner */}
      <Box
        sx={{
          bgcolor: "secondary.main",
          color: "white",
          textAlign: "center",
          py: 1.25,
          px: 2.5,
          fontSize: "1.2rem",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 1.5,
        }}
      >
        <Typography component="span" fontSize="inherit">
          Where does the{" "}
          <strong>{currentBird?.name ?? "..."}</strong>{" "}
          {currentBird?.scientificName && (
            <em>({currentBird.scientificName})</em>
          )}{" "}
          live?
        </Typography>
        <Typography
          component="span"
          sx={{ fontSize: "0.85rem", opacity: 0.8 }}
        >
          Click on the map to guess
        </Typography>
      </Box>

      {/* Map Container */}
      <Box sx={{ position: "relative", flex: 1, display: "flex", flexDirection: "column" }}>
        <Box ref={mapElRef} sx={{ flex: 1 }} />

        {/* Bird Photo */}
        {photo && (
          <Card
            sx={{
              position: "absolute",
              top: 10,
              right: 10,
              zIndex: 1000,
              width: 160,
              borderRadius: 2,
              boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
            }}
          >
            <CardMedia
              component="img"
              image={photo.url}
              alt={currentBird?.name ?? ""}
              sx={{ width: 160, height: 160, objectFit: "cover" }}
            />
            <Typography
              variant="caption"
              sx={{
                display: "block",
                px: 0.75,
                py: 0.5,
                fontSize: "0.6rem",
                color: "text.secondary",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {photo.attribution}
            </Typography>
          </Card>
        )}

        {/* Loading Overlay */}
        <Backdrop
          open={loading}
          sx={{ position: "absolute", zIndex: 999, bgcolor: "rgba(0,0,0,0.3)" }}
        >
          <Paper sx={{ px: 3.75, py: 2.5, borderRadius: 3 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
              <CircularProgress size={24} color="secondary" />
              <Typography variant="body1">Fetching range data...</Typography>
            </Box>
          </Paper>
        </Backdrop>

        {/* Result Panel */}
        {result && (
          <Paper
            elevation={6}
            sx={{
              position: "absolute",
              bottom: 30,
              left: "50%",
              transform: "translateX(-50%)",
              borderRadius: 3,
              px: 3.5,
              py: 2.5,
              zIndex: 1000,
              textAlign: "center",
              minWidth: 280,
            }}
          >
            {result.distanceKm === 0 ? (
              <>
                <Typography
                  sx={{ color: "secondary.main", fontWeight: 600 }}
                >
                  Inside the range!
                </Typography>
                <Typography
                  sx={{
                    fontSize: "1.8rem",
                    fontWeight: 700,
                    color: "primary.main",
                    my: 0.75,
                  }}
                >
                  0 km
                </Typography>
              </>
            ) : (
              <>
                <Typography>Distance to range:</Typography>
                <Typography
                  sx={{
                    fontSize: "1.8rem",
                    fontWeight: 700,
                    color: "primary.main",
                    my: 0.75,
                  }}
                >
                  {Math.round(result.distanceKm).toLocaleString()} km
                </Typography>
              </>
            )}
            <Typography sx={{ fontSize: "1.1rem", color: "text.secondary", mb: 1.75 }}>
              +{result.points.toLocaleString()} points
            </Typography>
            <Button
              variant="contained"
              color="secondary"
              onClick={handleNextBird}
              sx={{ px: 3.5, borderRadius: 2 }}
            >
              Next Bird
            </Button>
          </Paper>
        )}
      </Box>
    </Box>
  );
}
