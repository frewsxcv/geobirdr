import type { Bird, DailyStorage, RoundResult } from "./types";
import { DAILY_EPOCH, DATA_VERSION, MAX_POINTS } from "./constants";

const STORAGE_KEY = "geobirdr-daily";
const TOTAL_ROUNDS = 10;

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

export function getTodayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
}

export function getDayNumber(dateStr: string): number {
  const epoch = new Date(DAILY_EPOCH + "T00:00:00");
  const date = new Date(dateStr + "T00:00:00");
  return Math.floor((date.getTime() - epoch.getTime()) / 86400000) + 1;
}

export function getDailyBirds(
  allBirds: Bird[],
  dateStr: string,
  count: number = TOTAL_ROUNDS,
): Bird[] {
  const seed = hashString(dateStr + "-v" + DATA_VERSION);
  const rng = mulberry32(seed);

  const pool = [...allBirds];
  const selected: Bird[] = [];

  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    selected.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return selected;
}

export function getDailyResult(): DailyStorage | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data: DailyStorage = JSON.parse(raw);
    if (data.date !== getTodayET()) return null;
    return data;
  } catch {
    return null;
  }
}

function getYesterdayET(): string {
  const now = new Date();
  const etStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(now);
  const yesterday = new Date(etStr + "T00:00:00");
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

export function saveDailyResult(
  date: string,
  score: number,
  roundResults: RoundResult[],
  stars: number,
): DailyStorage {
  let streak = 1;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const prev: DailyStorage = JSON.parse(raw);
      if (prev.lastStreakDate === getYesterdayET()) {
        streak = prev.streak + 1;
      }
    }
  } catch {
    // ignore
  }

  const data: DailyStorage = {
    date,
    score,
    roundResults,
    stars,
    streak,
    lastStreakDate: date,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  return data;
}

export function isDailyCompleted(): boolean {
  return getDailyResult() !== null;
}

export function getDailyStreak(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const data: DailyStorage = JSON.parse(raw);
    const today = getTodayET();
    const yesterday = getYesterdayET();
    if (data.lastStreakDate === today || data.lastStreakDate === yesterday) {
      return data.streak;
    }
    return 0;
  } catch {
    return 0;
  }
}

function roundEmoji(points: number): string {
  const pct = points / MAX_POINTS;
  if (pct >= 1) return "\u{1F7E2}"; // green circle (perfect)
  if (pct >= 0.9) return "\u{1F7E9}"; // green square
  if (pct >= 0.7) return "\u{1F7E8}"; // yellow square
  if (pct >= 0.4) return "\u{1F7E7}"; // orange square
  return "\u{1F7E5}"; // red square
}

export function generateShareText(
  dateStr: string,
  score: number,
  stars: number,
  roundResults: RoundResult[],
  maxPoints: number,
): string {
  const dayNum = getDayNumber(dateStr);
  const starStr = "\u2B50".repeat(Math.floor(stars));
  const emojiGrid = roundResults.map((r) => roundEmoji(r.points)).join("");

  return [
    `GeoBirdr Daily #${dayNum}`,
    `${score.toLocaleString()} / ${maxPoints.toLocaleString()} ${starStr}`,
    emojiGrid,
    `https://frewsxcv.github.io/geobirdr/`,
  ].join("\n");
}
