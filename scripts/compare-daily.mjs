import { readFileSync } from "fs";

const birds = JSON.parse(readFileSync(new URL("../birds-ebird.json", import.meta.url), "utf-8"));
const gbifCounts = JSON.parse(readFileSync(new URL("../birds-gbif-counts.json", import.meta.url), "utf-8"));

// --- Replicate daily.ts logic ---
const DATA_VERSION = "2";
const DAILY_EPOCH = "2026-03-13";

const INAT_DIFFICULTY = {
  easy: { min: 40_000, max: Infinity },
  medium: { min: 10_000, max: 40_000 },
  hard: { min: 0, max: 10_000 },
};

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

function pickFromPool(pool, count, rng) {
  const available = [...pool];
  const selected = [];
  for (let i = 0; i < count && available.length > 0; i++) {
    const idx = Math.floor(rng() * available.length);
    selected.push(available[idx]);
    available.splice(idx, 1);
  }
  return selected;
}

function getDailyBirds(allBirds, dateStr, difficulty) {
  const seed = hashString(dateStr + "-v" + DATA_VERSION);
  const rng = mulberry32(seed);

  const easyBirds = allBirds.filter((b) => b.count >= difficulty.easy.min && b.count < difficulty.easy.max);
  const mediumBirds = allBirds.filter((b) => b.count >= difficulty.medium.min && b.count < difficulty.medium.max);
  const hardBirds = allBirds.filter((b) => b.count >= difficulty.hard.min && b.count < difficulty.hard.max);

  const selected = [
    ...pickFromPool(easyBirds, 3, rng),
    ...pickFromPool(mediumBirds, 2, rng),
    ...pickFromPool(hardBirds, 2, rng),
  ];

  for (let i = selected.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }
  return selected;
}

// --- Build bird lists ---
const inatBirds = birds.map((b) => ({ ...b, count: b.observationCount }));

// Figure out GBIF thresholds that produce similar tier sizes to iNat
const gbifValues = birds
  .map((b) => gbifCounts[b.scientificName] || 0)
  .filter((v) => v > 0)
  .sort((a, b) => b - a);

const totalBirds = gbifValues.length;
const easyCount = birds.filter((b) => b.observationCount >= 40_000).length;
const medCount = birds.filter((b) => b.observationCount >= 10_000 && b.observationCount < 40_000).length;

// Use percentile-based thresholds to get similar tier sizes
const easyPct = easyCount / birds.length;
const medPct = (easyCount + medCount) / birds.length;
const gbifEasyThreshold = gbifValues[Math.floor(totalBirds * easyPct)] || 0;
const gbifMedThreshold = gbifValues[Math.floor(totalBirds * medPct)] || 0;

console.log(`\n=== Tier Size Comparison ===`);
console.log(`iNat thresholds: easy >= 40K, medium >= 10K`);
console.log(`GBIF thresholds (percentile-matched): easy >= ${gbifEasyThreshold.toLocaleString()}, medium >= ${gbifMedThreshold.toLocaleString()}`);

const GBIF_DIFFICULTY = {
  easy: { min: gbifEasyThreshold, max: Infinity },
  medium: { min: gbifMedThreshold, max: gbifEasyThreshold },
  hard: { min: 0, max: gbifMedThreshold },
};

const gbifBirds = birds.map((b) => ({ ...b, count: gbifCounts[b.scientificName] || 0 }));

console.log(`\niNat tiers: easy=${inatBirds.filter(b => b.count >= 40000).length}, medium=${inatBirds.filter(b => b.count >= 10000 && b.count < 40000).length}, hard=${inatBirds.filter(b => b.count < 10000).length}`);
console.log(`GBIF tiers: easy=${gbifBirds.filter(b => b.count >= gbifEasyThreshold).length}, medium=${gbifBirds.filter(b => b.count >= gbifMedThreshold && b.count < gbifEasyThreshold).length}, hard=${gbifBirds.filter(b => b.count < gbifMedThreshold).length}`);

// --- Compare daily for tomorrow (2026-03-16) ---
const dateStr = "2026-03-16";

const inatDaily = getDailyBirds(inatBirds, dateStr, INAT_DIFFICULTY);
const gbifDaily = getDailyBirds(gbifBirds, dateStr, GBIF_DIFFICULTY);

console.log(`\n=== Daily Challenge for ${dateStr} ===\n`);
console.log(`--- With iNaturalist counts (current) ---`);
for (const b of inatDaily) {
  const tier = b.count >= 40000 ? "EASY" : b.count >= 10000 ? "MED" : "HARD";
  console.log(`  [${tier.padEnd(4)}] ${b.name} (${b.scientificName}) — iNat: ${b.count.toLocaleString()}`);
}

console.log(`\n--- With GBIF counts (proposed) ---`);
for (const b of gbifDaily) {
  const tier = b.count >= gbifEasyThreshold ? "EASY" : b.count >= gbifMedThreshold ? "MED" : "HARD";
  console.log(`  [${tier.padEnd(4)}] ${b.name} (${b.scientificName}) — GBIF: ${b.count.toLocaleString()}`);
}

// --- Show birds that shift tiers ---
console.log(`\n=== Notable Tier Shifts (iNat → GBIF) ===`);
const shifts = [];
for (const b of birds) {
  const inat = b.observationCount;
  const gbif = gbifCounts[b.scientificName] || 0;
  const inatTier = inat >= 40000 ? "easy" : inat >= 10000 ? "medium" : "hard";
  const gbifTier = gbif >= gbifEasyThreshold ? "easy" : gbif >= gbifMedThreshold ? "medium" : "hard";
  if (inatTier !== gbifTier) {
    shifts.push({ name: b.name, scientificName: b.scientificName, inat, gbif, inatTier, gbifTier });
  }
}

// Show some that moved UP (hard/medium → easy) — likely non-Americas birds
const movedUp = shifts.filter((s) => (s.inatTier === "hard" && s.gbifTier !== "hard") || (s.inatTier === "medium" && s.gbifTier === "easy"));
const movedDown = shifts.filter((s) => (s.inatTier === "easy" && s.gbifTier !== "easy") || (s.inatTier === "medium" && s.gbifTier === "hard"));

console.log(`\n${shifts.length} birds change tier. ${movedUp.length} move up, ${movedDown.length} move down.\n`);

console.log(`Top 15 birds that MOVE UP (become easier with GBIF):`);
movedUp.sort((a, b) => b.gbif - a.gbif);
for (const s of movedUp.slice(0, 15)) {
  console.log(`  ${s.name}: ${s.inatTier} → ${s.gbifTier} (iNat: ${s.inat.toLocaleString()}, GBIF: ${s.gbif.toLocaleString()})`);
}

console.log(`\nTop 15 birds that MOVE DOWN (become harder with GBIF):`);
movedDown.sort((a, b) => b.inat - a.inat);
for (const s of movedDown.slice(0, 15)) {
  console.log(`  ${s.name}: ${s.inatTier} → ${s.gbifTier} (iNat: ${s.inat.toLocaleString()}, GBIF: ${s.gbif.toLocaleString()})`);
}
