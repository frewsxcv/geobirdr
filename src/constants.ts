import type { DifficultyConfig, DifficultyKey } from "./types";

export const GCS_BASE = "https://storage.googleapis.com/geobirdr";
export const RANGES_URL = `${GCS_BASE}/ranges`;
export const TAXA_API = "https://api.inaturalist.org/v1/taxa";
export const MAX_POINTS = 5000;

export const DIFFICULTY: Record<DifficultyKey, DifficultyConfig> = {
  easy: { min: 80_000_000, max: Infinity, label: "Easy" },
  medium: { min: 10_000_000, max: 50_000_000, label: "Medium" },
  hard: { min: 500_000, max: 2_000_000, label: "Hard" },
  expert: { min: 0, max: 500_000, label: "Expert" },
  all: { min: 0, max: Infinity, label: "All Birds" },
};
