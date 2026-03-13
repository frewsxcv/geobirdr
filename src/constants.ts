import type { DifficultyConfig, DifficultyKey } from "./types";

export const GCS_BASE = import.meta.env.DEV
  ? "/api-gcs/geobirdr"
  : "https://storage.googleapis.com/geobirdr";
export const RANGES_URL = `${GCS_BASE}/ranges`;
export const TAXA_API = "https://api.inaturalist.org/v1/taxa";
export const MAX_POINTS = 5000;
export const DATA_VERSION = "2";

export const DAILY_EPOCH = "2026-03-12";

export const DIFFICULTY: Record<DifficultyKey, DifficultyConfig> = {
  easy: { min: 40_000, max: Infinity, label: "Easy" },
  medium: { min: 10_000, max: 40_000, label: "Medium" },
  hard: { min: 1_000, max: 10_000, label: "Hard" },
  expert: { min: 0, max: 1_000, label: "Expert" },
  all: { min: 0, max: Infinity, label: "All Birds" },
};
