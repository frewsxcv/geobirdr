export interface Bird {
  name: string;
  scientificName: string;
  speciesCode: string;
  areaKm2: number;
  observationCount: number;
}

export interface DifficultyConfig {
  min: number;
  max: number;
  label: string;
}

export type DifficultyKey = "easy" | "medium" | "hard" | "all";

export type GamePhase = "start" | "playing" | "finished";

export type GameMode = "freeplay" | "daily";

export interface RoundResult {
  birdName: string;
  distanceKm: number;
  points: number;
}

export interface DailyStorage {
  date: string;
  score: number;
  roundResults: RoundResult[];
  stars: number;
  streak: number;
  lastStreakDate: string;
}

