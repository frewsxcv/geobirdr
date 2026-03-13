import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import * as turf from "@turf/turf";
import type { FeatureCollection } from "geojson";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Backdrop from "@mui/material/Backdrop";
import LinearProgress from "@mui/material/LinearProgress";
import Rating from "@mui/material/Rating";
import Skeleton from "@mui/material/Skeleton";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Card from "@mui/material/Card";
import CardMedia from "@mui/material/CardMedia";
import Tooltip from "@mui/material/Tooltip";
import Divider from "@mui/material/Divider";
import Snackbar from "@mui/material/Snackbar";
import { DIFFICULTY, MAX_POINTS } from "./constants";
import { fetchBirds, fetchRange, fetchBirdPhoto } from "./api";
import type { GeoWorkerRequest, GeoWorkerResponse } from "./geo.worker";
import GeoWorker from "./geo.worker?worker";
import type { Bird, DifficultyKey, GameMode, GamePhase, RoundResult } from "./types";
import Avatar from "@mui/material/Avatar";
import AnimatedCounter from "./AnimatedCounter";
import {
  getTodayET,
  getDayNumber,
  getDailyBirds,
  getDailyResult,
  saveDailyResult,
  isDailyCompleted,
  getDailyStreak,
  generateShareText,
  DAILY_ROUNDS,
} from "./daily";

const FREEPLAY_ROUNDS = 10;

const LAYER_IDS = {
  rangeFill: "range-fill",
  rangeLine: "range-line",
  distanceLine: "distance-line",
} as const;

const SOURCE_IDS = {
  range: "range-source",
  guess: "guess-source",
  nearest: "nearest-source",
  distanceLine: "distance-line-source",
} as const;

const DIFFICULTY_DESCRIPTIONS: Record<DifficultyKey, string> = {
  easy: "Well-known birds \u2014 great for beginners",
  medium: "Familiar birds \u2014 a fair challenge",
  hard: "Obscure birds \u2014 for bird enthusiasts",
  all: "Anything goes",
};

function getStars(score: number, maxScore: number): number {
  const pct = score / maxScore;
  if (pct >= 0.9) return 5;
  if (pct >= 0.8) return 4.5;
  if (pct >= 0.7) return 4;
  if (pct >= 0.6) return 3.5;
  if (pct >= 0.5) return 3;
  if (pct >= 0.4) return 2.5;
  if (pct >= 0.3) return 2;
  return 1;
}


export default function App() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapElRef = useRef<HTMLDivElement>(null);
  const allBirdsRef = useRef<Bird[]>([]);
  const birdsRef = useRef<Bird[]>([]);
  const usedBirdsRef = useRef<Set<string>>(new Set());
  const guessAllowedRef = useRef(false);
  const guessMarkerRef = useRef<maplibregl.Marker | null>(null);
  const nearestMarkerRef = useRef<maplibregl.Marker | null>(null);
  const rangeDataRef = useRef<FeatureCollection | null>(null);
  const nextBirdRef = useRef<Bird | null>(null);
  const nextRangePromiseRef = useRef<Promise<FeatureCollection> | null>(null);
  const birdsLoadedRef = useRef(false);

  const [gamePhase, setGamePhase] = useState<GamePhase>("start");
  const [currentBird, setCurrentBird] = useState<Bird | null>(null);
  const [roundNum, setRoundNum] = useState(1);
  const [totalScore, setTotalScore] = useState(0);
  const [difficulty, setDifficulty] = useState<DifficultyKey>("easy");
  const [loadingRange, setLoadingRange] = useState(false);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [nextReady, setNextReady] = useState(false);
  const [photo, setPhoto] = useState<{
    url: string;
    attribution: string;
  } | null>(null);
  const [roundResults, setRoundResults] = useState<RoundResult[]>([]);
  const [calculating, setCalculating] = useState(false);
  const [birdsLoaded, setBirdsLoaded] = useState(false);
  const [gameMode, setGameMode] = useState<GameMode>("freeplay");
  const gameModeRef = useRef<GameMode>("freeplay");
  const dailyBirdsRef = useRef<Bird[]>([]);
  const roundIndexRef = useRef(0);
  const challengeDateRef = useRef("");
  const totalRoundsRef = useRef(FREEPLAY_ROUNDS);
  const [dailyCompleted, setDailyCompleted] = useState(false);
  const [startTab, setStartTab] = useState<"freeplay" | "daily">("daily");
  const [snackbarOpen, setSnackbarOpen] = useState(false);

  const filterBirds = useCallback((key: DifficultyKey) => {
    const diff = DIFFICULTY[key];
    birdsRef.current = allBirdsRef.current.filter(
      (b) => b.observationCount >= diff.min && b.observationCount < diff.max
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

  const pickNextBird = useCallback((): Bird => {
    if (gameModeRef.current === "daily") {
      return dailyBirdsRef.current[roundIndexRef.current++];
    }
    return pickRandomBird();
  }, [pickRandomBird]);

  const clearLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const id of Object.values(LAYER_IDS)) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of Object.values(SOURCE_IDS)) {
      if (map.getSource(id)) map.removeSource(id);
    }

    if (guessMarkerRef.current) {
      guessMarkerRef.current.remove();
      guessMarkerRef.current = null;
    }
    if (nearestMarkerRef.current) {
      nearestMarkerRef.current.remove();
      nearestMarkerRef.current = null;
    }
  }, []);

  const prefetchRange = useCallback(async (bird: Bird) => {
    setLoadingRange(true);
    guessAllowedRef.current = false;
    rangeDataRef.current = null;
    try {
      const geojson = await fetchRange(bird.speciesCode);
      rangeDataRef.current = geojson;
      guessAllowedRef.current = true;
    } catch (err) {
      console.error("Failed to prefetch range:", err);
    }
    setLoadingRange(false);
  }, []);

  // Pre-fetch the next bird's range in the background (called after a guess)
  const prefetchNextBird = useCallback(() => {
    const bird = pickNextBird();
    nextBirdRef.current = bird;
    setNextReady(false);
    const promise = fetchRange(bird.speciesCode);
    nextRangePromiseRef.current = promise;
    promise
      .then(() => setNextReady(true))
      .catch(() => setNextReady(true)); // allow advancing even on error
  }, [pickNextBird]);

  const startRound = useCallback(() => {
    clearLayers();
    setResult(null);
    rangeDataRef.current = null;
    nextBirdRef.current = null;
    nextRangePromiseRef.current = null;
    setNextReady(false);

    const bird = pickNextBird();
    setCurrentBird(bird);
    setPhoto(null);
    mapRef.current?.flyTo({ center: [0, 20], zoom: 1.5, duration: 0 });

    fetchBirdPhoto(bird.scientificName).then((p) => {
      if (p) setPhoto(p);
    });
    prefetchRange(bird);
  }, [clearLayers, pickNextBird, prefetchRange]);

  // Advance to the pre-fetched next bird
  const advanceToNextBird = useCallback(async () => {
    // If this was the last round, go to finished
    if (roundNum >= totalRoundsRef.current) {
      setGamePhase("finished");
      return;
    }


    const bird = nextBirdRef.current;
    if (!bird) return;

    clearLayers();
    setResult(null);
    setNextReady(false);
    setRoundNum((n) => n + 1);
    setCurrentBird(bird);
    setPhoto(null);
    mapRef.current?.flyTo({ center: [0, 20], zoom: 1.5, duration: 0 });

    fetchBirdPhoto(bird.scientificName).then((p) => {
      if (p) setPhoto(p);
    });

    // Use the pre-fetched range data
    setLoadingRange(true);
    guessAllowedRef.current = false;
    rangeDataRef.current = null;
    try {
      const geojson = await nextRangePromiseRef.current!;
      rangeDataRef.current = geojson;
      guessAllowedRef.current = true;
    } catch (err) {
      console.error("Failed to load range:", err);
    }
    setLoadingRange(false);
    nextBirdRef.current = null;
    nextRangePromiseRef.current = null;
  }, [clearLayers, roundNum]);

  const handleGuess = useCallback(
    (e: maplibregl.MapMouseEvent) => {
      if (gamePhase !== "playing") return;
      if (!guessAllowedRef.current || !currentBird || !rangeDataRef.current)
        return;
      guessAllowedRef.current = false;

      const map = mapRef.current!;
      const { lng, lat } = e.lngLat;
      const geojson = rangeDataRef.current;

      // Place guess marker
      const guessEl = document.createElement("div");
      guessEl.style.cssText =
        "background:#e63946;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
      guessMarkerRef.current = new maplibregl.Marker({ element: guessEl })
        .setLngLat([lng, lat])
        .addTo(map);

      // Show range polygon immediately
      map.addSource(SOURCE_IDS.range, { type: "geojson", data: geojson });
      map.addLayer({
        id: LAYER_IDS.rangeFill,
        type: "fill",
        source: SOURCE_IDS.range,
        paint: {
          "fill-color": "#40916c",
          "fill-opacity": 0.3,
        },
      });
      map.addLayer({
        id: LAYER_IDS.rangeLine,
        type: "line",
        source: SOURCE_IDS.range,
        paint: {
          "line-color": "#2d6a4f",
          "line-width": 2,
        },
      });

      // Fit bounds to show guess and range
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([lng, lat]);
      for (const feature of geojson.features) {
        if (!feature.geometry || !("coordinates" in feature.geometry)) continue;
        const bbox = turf.bbox(feature);
        bounds.extend([bbox[0], bbox[1]]);
        bounds.extend([bbox[2], bbox[3]]);
      }
      map.fitBounds(bounds, { padding: 50 });

      // Start pre-fetching the next bird's range immediately (if not last round)
      if (roundNum < totalRoundsRef.current) {
        prefetchNextBird();
      } else {
        setNextReady(true);
      }

      // Compute distance off the main thread
      setCalculating(true);
      const birdName = currentBird.name;
      const worker = new GeoWorker();
      const request: GeoWorkerRequest = { lng, lat, geojson };
      worker.postMessage(request);
      worker.onmessage = (msg: MessageEvent<GeoWorkerResponse>) => {
        const { distanceKm, nearest } = msg.data;
        worker.terminate();

        if (nearest && distanceKm > 0) {
          let guessLng = lng;
          let nearLng = nearest[0];
          if (nearLng - guessLng > 180) nearLng -= 360;
          else if (guessLng - nearLng > 180) nearLng += 360;

          map.addSource(SOURCE_IDS.distanceLine, {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: [
                  [guessLng, lat],
                  [nearLng, nearest[1]],
                ],
              },
            },
          });
          map.addLayer({
            id: LAYER_IDS.distanceLine,
            type: "line",
            source: SOURCE_IDS.distanceLine,
            paint: {
              "line-color": "#e63946",
              "line-width": 2,
              "line-dasharray": [3, 2],
            },
          });

          const nearEl = document.createElement("div");
          nearEl.style.cssText =
            "background:#40916c;width:12px;height:12px;border-radius:50%;border:2px solid #2d6a4f;";
          nearestMarkerRef.current = new maplibregl.Marker({ element: nearEl })
            .setLngLat([nearLng, nearest[1]])
            .addTo(map);
        }

        const points = Math.max(0, Math.round(MAX_POINTS - distanceKm));
        const roundResult: RoundResult = { birdName, distanceKm, points };
        setTotalScore((prev) => prev + points);
        setResult(roundResult);
        setRoundResults((prev) => [...prev, roundResult]);
        setCalculating(false);
      };
    },
    [currentBird, prefetchNextBird, gamePhase, roundNum]
  );

  // Initialize map and load birds
  useEffect(() => {
    if (mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapElRef.current!,
      style: "https://tiles.openfreemap.org/styles/bright",
      center: [0, 20],
      zoom: 1.5,
      renderWorldCopies: true,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    mapRef.current = map;

    fetchBirds().then((data) => {
      allBirdsRef.current = data;
      birdsLoadedRef.current = true;
      setBirdsLoaded(true);
    });
  }, []);

  // Check daily completion on mount
  useEffect(() => {
    setDailyCompleted(isDailyCompleted());
  }, []);

  // Save daily result when game finishes
  useEffect(() => {
    if (gamePhase === "finished" && gameModeRef.current === "daily") {
      const score = roundResults.reduce((sum, r) => sum + r.points, 0);
      const stars = getStars(score, MAX_POINTS * totalRoundsRef.current);
      saveDailyResult(challengeDateRef.current, score, roundResults, stars);
      setDailyCompleted(true);
    }
  }, [gamePhase, roundResults]);

  // Wire up map click handler
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e: maplibregl.MapMouseEvent) => handleGuess(e);
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [handleGuess]);

  const handleStartGame = (mode: GameMode = "freeplay") => {
    setGameMode(mode);
    gameModeRef.current = mode;

    if (mode === "daily") {
      const today = getTodayET();
      challengeDateRef.current = today;
      dailyBirdsRef.current = getDailyBirds(allBirdsRef.current, today);
      roundIndexRef.current = 0;
      totalRoundsRef.current = DAILY_ROUNDS;
    } else {
      filterBirds(difficulty);
      totalRoundsRef.current = FREEPLAY_ROUNDS;
    }

    usedBirdsRef.current.clear();
    setTotalScore(0);
    setRoundNum(1);
    setRoundResults([]);
    setGamePhase("playing");
    startRound();
  };

  const handlePlayAgain = () => {
    clearLayers();
    setResult(null);
    setCurrentBird(null);
    setPhoto(null);
    setGamePhase("start");
    setDailyCompleted(isDailyCompleted());
  };

  const handleShare = (dateStr: string, score: number, stars: number, results: RoundResult[]) => {
    const text = generateShareText(dateStr, score, stars, results, MAX_POINTS * totalRoundsRef.current);
    navigator.clipboard.writeText(text).then(() => {
      setSnackbarOpen(true);
    });
  };

  const isLastRound = roundNum >= totalRoundsRef.current;
  const finalScore = roundResults.reduce((sum, r) => sum + r.points, 0);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Header */}
      <AppBar position="static" sx={{ bgcolor: "primary.main", zIndex: 1000 }}>
        <Toolbar sx={{ justifyContent: "space-between" }}>
          <Typography variant="h6" sx={{ letterSpacing: 1 }}>
            GeoBirdr
          </Typography>
          {gamePhase === "playing" && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
              <Tooltip title={gameMode === "daily" ? "Daily Challenge" : DIFFICULTY_DESCRIPTIONS[difficulty]} arrow>
                <Chip label={gameMode === "daily" ? `Daily #${getDayNumber(challengeDateRef.current)}` : DIFFICULTY[difficulty].label} size="small" sx={{ bgcolor: "rgba(255,255,255,0.15)", color: "white", fontWeight: 500 }} />
              </Tooltip>
              <Typography variant="body1" sx={{ opacity: 0.9 }}>
                Round {roundNum} / {totalRoundsRef.current} &nbsp;|&nbsp; Score:{" "}
                <AnimatedCounter value={totalScore} />
              </Typography>
              <Button
                variant="outlined"
                size="small"
                onClick={handlePlayAgain}
                sx={{
                  color: "white",
                  borderColor: "rgba(255,255,255,0.4)",
                  textTransform: "none",
                  fontSize: "0.8rem",
                  "&:hover": { borderColor: "white", bgcolor: "rgba(255,255,255,0.1)" },
                }}
              >
                Quit
              </Button>
            </Box>
          )}
        </Toolbar>
      </AppBar>

      {/* Bird Banner - only during playing phase */}
      {gamePhase === "playing" && (
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
            {loadingRange ? "Loading range..." : "Click on the map to guess"}
          </Typography>
        </Box>
      )}

      {/* Round Progress Bar */}
      {gamePhase === "playing" && (
        <LinearProgress
          variant="determinate"
          value={(roundNum / totalRoundsRef.current) * 100}
          sx={{
            height: 4,
            zIndex: 1000,
            bgcolor: "rgba(0,0,0,0.1)",
            "& .MuiLinearProgress-bar": {
              bgcolor: "grey.500",
            },
          }}
        />
      )}

      {/* Map Container */}
      <Box
        sx={{
          position: "relative",
          flex: 1,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box ref={mapElRef} sx={{ flex: 1 }} />

        {/* Start Screen Overlay */}
        {gamePhase === "start" && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              zIndex: 1100,
              bgcolor: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Paper
              elevation={8}
              sx={{
                p: 4,
                borderRadius: 3,
                maxWidth: 520,
                width: "90%",
                textAlign: "center",
              }}
            >
              <Typography variant="h4" sx={{ fontWeight: 700, mb: 1 }}>
                GeoBirdr
              </Typography>
              <Typography sx={{ color: "text.secondary", mb: 3 }}>
                Guess where birds live! Click on the map
                to place your guess.
              </Typography>

              {/* Mode Tabs */}
              <ToggleButtonGroup
                value={startTab}
                exclusive
                onChange={(_e, val) => { if (val !== null) setStartTab(val); }}
                fullWidth
                sx={{ mb: 2.5 }}
              >
                <ToggleButton value="daily" sx={{ textTransform: "none", fontWeight: 600, "&.Mui-selected": { bgcolor: "primary.main", color: "white", "&:hover": { bgcolor: "primary.dark" } } }}>
                  Daily
                </ToggleButton>
                <ToggleButton value="freeplay" sx={{ textTransform: "none", fontWeight: 600, "&.Mui-selected": { bgcolor: "primary.main", color: "white", "&:hover": { bgcolor: "primary.dark" } } }}>
                  Free Play
                </ToggleButton>
              </ToggleButtonGroup>

              {startTab === "freeplay" && (
                <>
                  <Typography
                    variant="subtitle1"
                    sx={{ fontWeight: 600, mb: 1.5 }}
                  >
                    Choose Difficulty
                  </Typography>

                  <ToggleButtonGroup
                    value={difficulty}
                    exclusive
                    onChange={(_e, val) => { if (val !== null) setDifficulty(val); }}
                    orientation="vertical"
                    fullWidth
                    sx={{ mb: 3 }}
                  >
                    {(
                      ["easy", "medium", "hard", "all"] as DifficultyKey[]
                    ).map((key) => (
                      <ToggleButton
                        key={key}
                        value={key}
                        sx={{
                          justifyContent: "flex-start",
                          textTransform: "none",
                          py: 1.25,
                          px: 2.5,
                          "&.Mui-selected": {
                            bgcolor: "primary.main",
                            color: "white",
                            "&:hover": { bgcolor: "primary.dark" },
                          },
                        }}
                      >
                        <Box sx={{ textAlign: "left" }}>
                          <Typography sx={{ fontWeight: 600, fontSize: "0.95rem" }}>
                            {DIFFICULTY[key].label}
                          </Typography>
                          <Typography
                            sx={{ fontSize: "0.8rem", opacity: 0.7 }}
                          >
                            {DIFFICULTY_DESCRIPTIONS[key]}
                          </Typography>
                        </Box>
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>

                  <Button
                    variant="contained"
                    color="secondary"
                    size="large"
                    onClick={() => handleStartGame("freeplay")}
                    disabled={!birdsLoaded}
                    sx={{ px: 5, borderRadius: 2, fontWeight: 600 }}
                  >
                    {birdsLoaded ? "Start Game" : "Loading..."}
                  </Button>
                </>
              )}

              {startTab === "daily" && !dailyCompleted && (
                <>
                  <Typography sx={{ color: "text.secondary", mb: 2 }}>
                    Same {DAILY_ROUNDS} birds for everyone. Resets at midnight ET.
                  </Typography>
                  {getDailyStreak() > 0 && (
                    <Typography sx={{ mb: 2, fontWeight: 600 }}>
                      Current streak: {getDailyStreak()} day{getDailyStreak() !== 1 ? "s" : ""}
                    </Typography>
                  )}
                  <Button
                    variant="contained"
                    color="secondary"
                    size="large"
                    onClick={() => handleStartGame("daily")}
                    disabled={!birdsLoaded}
                    sx={{ px: 5, borderRadius: 2, fontWeight: 600 }}
                  >
                    {birdsLoaded ? "Play Today's Challenge" : "Loading..."}
                  </Button>
                </>
              )}

              {startTab === "daily" && dailyCompleted && (() => {
                const dailyResult = getDailyResult()!;
                return (
                  <>
                    <Typography sx={{ fontSize: "2rem", fontWeight: 800, color: "primary.main", lineHeight: 1.2 }}>
                      {dailyResult.score.toLocaleString()}
                    </Typography>
                    <Typography sx={{ fontSize: "0.95rem", color: "text.secondary", mb: 0.5 }}>
                      out of {(MAX_POINTS * DAILY_ROUNDS).toLocaleString()} points
                    </Typography>
                    <Rating value={dailyResult.stars} precision={0.5} readOnly size="large" />

                    <Box sx={{ maxHeight: 200, overflow: "auto", my: 2, border: "1px solid", borderColor: "divider", borderRadius: 2 }}>
                      {dailyResult.roundResults.map((r, i) => (
                        <Box key={i} sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", px: 2, py: 0.75, borderBottom: i < dailyResult.roundResults.length - 1 ? "1px solid" : "none", borderColor: "divider", bgcolor: i % 2 === 0 ? "action.hover" : "transparent" }}>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                            <Avatar sx={{ width: 28, height: 28, fontSize: "0.75rem", bgcolor: "primary.main" }}>{i + 1}</Avatar>
                            <Typography sx={{ fontSize: "0.85rem" }}>{r.birdName}</Typography>
                          </Box>
                          <Box sx={{ textAlign: "right" }}>
                            <Typography sx={{ fontSize: "0.85rem", fontWeight: 600 }}>{r.points.toLocaleString()} pts</Typography>
                            <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>
                              {r.distanceKm === 0 ? "Inside range" : `${Math.round(r.distanceKm).toLocaleString()} km`}
                            </Typography>
                          </Box>
                        </Box>
                      ))}
                    </Box>

                    <Button
                      variant="contained"
                      color="secondary"
                      size="large"
                      onClick={() => handleShare(dailyResult.date, dailyResult.score, dailyResult.stars, dailyResult.roundResults)}
                      sx={{ px: 5, borderRadius: 2, fontWeight: 600, mb: 1.5 }}
                    >
                      Share Results
                    </Button>

                    {dailyResult.streak > 0 && (
                      <Typography sx={{ fontWeight: 600, mb: 1 }}>
                        Streak: {dailyResult.streak} day{dailyResult.streak !== 1 ? "s" : ""}
                      </Typography>
                    )}
                    <Typography sx={{ color: "text.secondary", fontSize: "0.9rem" }}>
                      Come back tomorrow!
                    </Typography>
                  </>
                );
              })()}

              <Typography
                sx={{ mt: 3, fontSize: "0.75rem", color: "text.secondary" }}
              >
                Made by{" "}
                <a href="https://rwell.org" target="_blank" rel="noopener noreferrer">
                  Corey Farwell
                </a>
              </Typography>
              <Typography
                sx={{ mt: 1, fontSize: "0.6rem", color: "text.disabled", fontStyle: "italic", lineHeight: 1.4, maxWidth: 440, mx: "auto" }}
              >
                Fink, D. et al. 2024. eBird Status and Trends, Data Version:
                2023; Released: 2025. Cornell Lab of Ornithology, Ithaca, New
                York.{" "}
                <a href="https://doi.org/10.2173/WZTW8903" target="_blank" rel="noopener noreferrer">
                  DOI
                </a>
              </Typography>
            </Paper>
          </Box>
        )}

        <Backdrop
          open={gamePhase === "start" && !birdsLoaded}
          sx={{
            zIndex: 1200,
            color: "#fff",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <CircularProgress color="inherit" />
          <Typography color="inherit">Loading bird data...</Typography>
        </Backdrop>

        {/* Game Over Overlay */}
        {gamePhase === "finished" && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              zIndex: 1100,
              bgcolor: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "auto",
            }}
          >
            <Paper
              elevation={8}
              sx={{
                p: 4,
                borderRadius: 3,
                maxWidth: 560,
                width: "90%",
                textAlign: "center",
                my: 4,
              }}
            >
              <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>
                {gameMode === "daily" ? `GeoBirdr Daily #${getDayNumber(challengeDateRef.current)}` : "Game Over!"}
              </Typography>
              <Typography
                sx={{
                  fontSize: "3rem",
                  fontWeight: 800,
                  color: "primary.main",
                  lineHeight: 1.2,
                }}
              >
                {finalScore.toLocaleString()}
              </Typography>
              <Typography
                sx={{ fontSize: "1.1rem", color: "text.secondary", mb: 0.5 }}
              >
                out of {(MAX_POINTS * totalRoundsRef.current).toLocaleString()} points
              </Typography>
              <Rating
                value={getStars(finalScore, MAX_POINTS * totalRoundsRef.current)}
                precision={0.5}
                readOnly
                size="large"
              />
              <Divider sx={{ my: 2 }} />

              {/* Round Breakdown */}
              <Typography
                variant="subtitle1"
                sx={{ fontWeight: 600, mb: 1 }}
              >
                Round Breakdown
              </Typography>
              <Box
                sx={{
                  maxHeight: 240,
                  overflow: "auto",
                  mb: 2.5,
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: 2,
                }}
              >
                {roundResults.map((r, i) => (
                  <Box
                    key={i}
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      px: 2,
                      py: 0.75,
                      borderBottom:
                        i < roundResults.length - 1
                          ? "1px solid"
                          : "none",
                      borderColor: "divider",
                      bgcolor: i % 2 === 0 ? "action.hover" : "transparent",
                    }}
                  >
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                      <Avatar
                        sx={{
                          width: 28,
                          height: 28,
                          fontSize: "0.75rem",
                          bgcolor: "primary.main",
                        }}
                      >
                        {i + 1}
                      </Avatar>
                      <Typography sx={{ fontSize: "0.85rem" }}>
                        {r.birdName}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: "right" }}>
                      <Typography sx={{ fontSize: "0.85rem", fontWeight: 600 }}>
                        {r.points.toLocaleString()} pts
                      </Typography>
                      <Typography
                        sx={{ fontSize: "0.7rem", color: "text.secondary" }}
                      >
                        {r.distanceKm === 0
                          ? "Inside range"
                          : `${Math.round(r.distanceKm).toLocaleString()} km`}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </Box>
              <Divider sx={{ my: 2 }} />

              {gameMode === "daily" && (
                <>
                  <Button
                    variant="contained"
                    color="secondary"
                    size="large"
                    onClick={() => handleShare(challengeDateRef.current, finalScore, getStars(finalScore, MAX_POINTS * totalRoundsRef.current), roundResults)}
                    sx={{ px: 5, borderRadius: 2, fontWeight: 600, mb: 1.5 }}
                  >
                    Share Results
                  </Button>
                  {getDailyStreak() > 0 && (
                    <Typography sx={{ mb: 1.5, fontWeight: 600 }}>
                      Streak: {getDailyStreak()} day{getDailyStreak() !== 1 ? "s" : ""}
                    </Typography>
                  )}
                </>
              )}
              <Button
                variant="contained"
                color={gameMode === "daily" ? "primary" : "secondary"}
                size="large"
                onClick={handlePlayAgain}
                sx={{ px: 5, borderRadius: 2, fontWeight: 600 }}
              >
                {gameMode === "daily" ? "Back to Menu" : "Play Again"}
              </Button>
            </Paper>
          </Box>
        )}

        {/* Bird Photo */}
        {gamePhase === "playing" && (
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
            {photo ? (
              <CardMedia
                component="img"
                image={photo.url}
                alt={currentBird?.name ?? ""}
                sx={{ width: 160, height: 160, objectFit: "cover" }}
              />
            ) : (
              <Skeleton variant="rectangular" width={160} height={160} animation="wave" />
            )}
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
              {photo ? <>&copy; {photo.attribution}</> : <Skeleton width="80%" />}
            </Typography>
          </Card>
        )}

        {/* Calculating Spinner */}
        {gamePhase === "playing" && calculating && !result && (
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
              minWidth: 200,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 1.5,
            }}
          >
            <CircularProgress size={24} />
            <Typography>Calculating distance...</Typography>
          </Paper>
        )}

        {/* Result Panel */}
        {gamePhase === "playing" && result && (
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
            <Typography
              sx={{ fontSize: "1.1rem", color: "text.secondary", mb: 1.75 }}
            >
              <AnimatedCounter value={result.points} prefix="+" suffix=" points" />
            </Typography>
            <Typography
              sx={{ fontSize: "0.8rem", color: "text.secondary", mb: 1.5 }}
            >
              <Tooltip title="See this bird's full range map on eBird" arrow>
                <a
                  href={`https://science.ebird.org/en/status-and-trends/species/${currentBird?.speciesCode}/range-map`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View range on eBird
                </a>
              </Tooltip>
            </Typography>
            <Button
              variant="contained"
              color="secondary"
              onClick={advanceToNextBird}
              disabled={!nextReady}
              sx={{ px: 3.5, borderRadius: 2 }}
              startIcon={
                !nextReady ? (
                  <CircularProgress size={18} color="inherit" />
                ) : undefined
              }
            >
              {!nextReady
                ? "Loading..."
                : isLastRound
                  ? "Finish"
                  : "Next Bird"}
            </Button>
          </Paper>
        )}
      </Box>
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={2000}
        onClose={() => setSnackbarOpen(false)}
        message="Copied to clipboard!"
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}
