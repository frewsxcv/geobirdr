import { readFileSync, writeFileSync } from "fs";

const INPUT_PATH = new URL("../birds-ebird.json", import.meta.url);
const OUTPUT_PATH = new URL("../birds-gbif-counts.json", import.meta.url);
const CONCURRENCY = 10;
const DELAY_MS = 200;

const birds = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));

// Fetch eBird taxonomy to get family names for each species (keyed by speciesCode)
console.log("Fetching eBird taxonomy for family lookup...");
const ebirdTaxRes = await fetch(
  "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&cat=species",
  { headers: { "X-eBirdApiToken": "demo" } },
);
const ebirdTaxonomy = await ebirdTaxRes.json();
const familyByCode = {};
for (const t of ebirdTaxonomy) {
  if (t.speciesCode && t.familySciName) familyByCode[t.speciesCode] = t.familySciName;
}
console.log(`Loaded ${Object.keys(familyByCode).length} family mappings from eBird taxonomy`);

const familyBySpecies = {};
for (const b of birds) {
  const family = familyByCode[b.speciesCode];
  if (family) familyBySpecies[b.scientificName] = family;
}

// Try to load previous partial results
let results;
try {
  results = JSON.parse(readFileSync(OUTPUT_PATH, "utf-8"));
  console.log(`Resuming: ${Object.keys(results).length} already fetched`);
} catch {
  results = {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache family name -> GBIF taxonKey
const familyKeyCache = {};

async function getFamilyKey(familyName) {
  if (familyKeyCache[familyName]) return familyKeyCache[familyName];
  const url = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(familyName)}&rank=FAMILY&kingdom=Animalia`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const key = data.usageKey || null;
  if (key) familyKeyCache[familyName] = key;
  return key;
}

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

async function matchByEpithetAndFamily(scientificName, familyName) {
  if (!familyName) return null;

  const epithet = scientificName.split(" ").slice(-1)[0];
  const stem = epithet.replace(/(us|a|um|is|e|ensis|alis|aris)$/, "");
  const familyKey = await getFamilyKey(familyName);
  if (!familyKey) return null;

  // GBIF search requires complete words, so try the original epithet plus
  // common Latin gender variants (e.g. virgata→virgatus, decussata→decussatus)
  const variants = new Set([epithet]);
  for (const suffix of ["us", "a", "um", "is", "e", "ensis", "alis", "aris"]) {
    variants.add(stem + suffix);
  }

  for (const query of variants) {
    const url = `https://api.gbif.org/v1/species/search?q=${encodeURIComponent(query)}&highertaxonKey=${familyKey}&rank=SPECIES&limit=10`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();

    // Find a species whose epithet stem matches
    for (const r of data.results) {
      const candEpithet = (r.canonicalName || "").split(" ").slice(-1)[0];
      const candStem = candEpithet.replace(/(us|a|um|is|e|ensis|alis|aris)$/, "");
      if (candStem === stem) {
        return r.acceptedKey || r.nubKey || r.key;
      }
    }
  }
  return null;
}

async function getCount(taxonKey) {
  const url = `https://api.gbif.org/v1/occurrence/count?taxonKey=${taxonKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Count HTTP ${res.status}`);
  return parseInt(await res.text(), 10) || 0;
}

async function fetchGBIFCount(scientificName) {
  // Step 1: Try direct name match (works for ~99% of species)
  let taxonKey = await matchSpecies(scientificName);

  // Step 2: If no match, search by epithet within the bird's family.
  // This handles recent genus reclassifications where eBird uses a new genus
  // name that GBIF hasn't adopted yet (e.g. Tachyspiza→Accipiter).
  if (!taxonKey) {
    const family = familyBySpecies[scientificName];
    taxonKey = await matchByEpithetAndFamily(scientificName, family);
    if (taxonKey) {
      console.log(`  Fallback match: ${scientificName} → taxonKey ${taxonKey}`);
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
