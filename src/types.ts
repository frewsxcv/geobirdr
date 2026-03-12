export interface Bird {
  name: string;
  scientificName: string;
  speciesCode: string;
  areaKm2: number;
}

export interface DifficultyConfig {
  min: number;
  max: number;
  label: string;
}

export type DifficultyKey = "easy" | "medium" | "hard" | "expert" | "all";

export type GamePhase = "start" | "playing" | "finished";

export interface RoundResult {
  birdName: string;
  distanceKm: number;
  points: number;
}

