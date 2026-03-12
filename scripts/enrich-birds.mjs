import { readFileSync, writeFileSync } from "fs";

const INPUT_PATH = new URL("../birds-ebird.json", import.meta.url);
const BATCH_SIZE = 5;
const DELAY_MS = 1200;
const MAX_RETRIES = 3;

const birds = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));

// Count how many already have observationCount > 0 (from a previous partial run)
const alreadyDone = birds.filter((b) => b.observationCount > 0).length;
console.log(`Loaded ${birds.length} birds (${alreadyDone} already enriched)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchObservationCount(scientificName, retries = MAX_RETRIES) {
  const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(scientificName)}&rank=species&per_page=1`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const wait = Math.min(2000 * Math.pow(2, attempt), 30000);
        console.warn(`  429 for "${scientificName}", retrying in ${wait}ms (attempt ${attempt}/${retries})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.results?.[0]?.observations_count ?? 0;
    } catch (err) {
      if (attempt === retries) {
        console.warn(`  Failed for "${scientificName}": ${err.message}`);
        return 0;
      }
      await sleep(2000 * attempt);
    }
  }
  return 0;
}

let processed = 0;

for (let i = 0; i < birds.length; i += BATCH_SIZE) {
  const batch = birds.slice(i, i + BATCH_SIZE);

  // Skip birds that already have a valid observationCount from a prior run
  const needsFetch = batch.filter((b) => !(b.observationCount > 0));
  if (needsFetch.length === 0) {
    processed += batch.length;
    continue;
  }

  const counts = await Promise.all(
    batch.map((b) =>
      b.observationCount > 0
        ? Promise.resolve(b.observationCount)
        : fetchObservationCount(b.scientificName)
    )
  );
  for (let j = 0; j < batch.length; j++) {
    batch[j].observationCount = counts[j];
  }
  processed += batch.length;

  if (processed % 100 < BATCH_SIZE || processed >= birds.length) {
    console.log(`Progress: ${Math.min(processed, birds.length)} / ${birds.length}`);
  }

  // Save periodically every 500 birds
  if (processed % 500 < BATCH_SIZE) {
    writeFileSync(INPUT_PATH, JSON.stringify(birds, null, 2) + "\n");
    console.log("  (checkpoint saved)");
  }

  if (i + BATCH_SIZE < birds.length) {
    await sleep(DELAY_MS);
  }
}

writeFileSync(INPUT_PATH, JSON.stringify(birds, null, 2) + "\n");
console.log("Done — wrote enriched data back to birds-ebird.json");
