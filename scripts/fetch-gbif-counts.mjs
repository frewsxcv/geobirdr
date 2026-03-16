import { readFileSync, writeFileSync } from "fs";

const INPUT_PATH = new URL("../birds-ebird.json", import.meta.url);
const OUTPUT_PATH = new URL("../birds-gbif-counts.json", import.meta.url);
const CONCURRENCY = 10;
const DELAY_MS = 200;

// eBird uses newer taxonomy; GBIF still uses older genus names for these groups.
const GENUS_SYNONYMS = {
  Anarhynchus: "Charadrius",
  Astur: "Accipiter",
  Botaurus: "Ixobrychus",
  Chloris: "Carduelis",
  Daptrius: ["Milvago", "Phalcoboenus"],
  Driophlox: "Habia",
  Hesperoburhinus: "Burhinus",
  Lophospiza: "Accipiter",
  Neophilydor: "Philydor",
  Plocealauda: "Mirafra",
  Quechuavis: "Caprimulgus",
  Tachyspiza: "Accipiter",
  Thinornis: "Charadrius",
};

const birds = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));

// Try to load previous partial results
let results;
try {
  results = JSON.parse(readFileSync(OUTPUT_PATH, "utf-8"));
  console.log(`Resuming: ${Object.keys(results).length} already fetched`);
} catch {
  results = {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function matchSpecies(name) {
  const url = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(name)}&kingdom=Animalia`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Match HTTP ${res.status}`);
  const data = await res.json();
  if (data.matchType === "NONE" || data.matchType === "HIGHERRANK") return null;
  if (data.rank !== "SPECIES") return null;
  if (data.kingdom !== "Animalia") return null;
  return data.usageKey || null;
}

async function getCount(taxonKey) {
  const url = `https://api.gbif.org/v1/occurrence/count?taxonKey=${taxonKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Count HTTP ${res.status}`);
  return parseInt(await res.text(), 10) || 0;
}

async function fetchGBIFCount(scientificName) {
  // Try the name as-is first
  let taxonKey = await matchSpecies(scientificName);

  // If no match, try synonym genera
  if (!taxonKey) {
    const [genus, ...rest] = scientificName.split(" ");
    const epithet = rest.join(" ");
    const synonyms = GENUS_SYNONYMS[genus];
    if (synonyms) {
      const candidates = Array.isArray(synonyms) ? synonyms : [synonyms];
      for (const syn of candidates) {
        taxonKey = await matchSpecies(`${syn} ${epithet}`);
        if (taxonKey) break;
      }
    }
  }

  if (!taxonKey) return 0;
  return getCount(taxonKey);
}

// Find entries that need re-fetching (bad data or missing)
const BAD_THRESHOLD = 100_000_000; // 100M+ is clearly wrong
const toFetch = birds.filter((b) => {
  const val = results[b.scientificName];
  return val === undefined || val >= BAD_THRESHOLD;
});

let processed = birds.length - toFetch.length;
console.log(`Need to fetch ${toFetch.length} of ${birds.length} birds`);

for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
  const batch = toFetch.slice(i, i + CONCURRENCY);
  const counts = await Promise.all(
    batch.map(async (b) => {
      try {
        return { name: b.scientificName, count: await fetchGBIFCount(b.scientificName) };
      } catch (err) {
        console.warn(`  Failed: ${b.scientificName}: ${err.message}`);
        return { name: b.scientificName, count: -1 };
      }
    })
  );

  for (const { name, count } of counts) {
    if (count >= 0) results[name] = count;
  }
  processed += batch.length;

  if (processed % 100 < CONCURRENCY || i + CONCURRENCY >= toFetch.length) {
    console.log(`Progress: ${processed} / ${birds.length}`);
  }

  if (processed % 200 < CONCURRENCY) {
    writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2) + "\n");
  }

  if (i + CONCURRENCY < toFetch.length) await sleep(DELAY_MS);
}

writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2) + "\n");
console.log(`Done — wrote ${Object.keys(results).length} counts to birds-gbif-counts.json`);
