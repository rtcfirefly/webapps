// ─── EXERCISE DB ──────────────────────────────────────────────────────────────
// Loaded lazily from free-exercise-db (800+ exercises); keyed by lowercase name.
// Provides photo illustrations (start/end positions) and step-by-step instructions.

const EXDB = {}; // name → { id, images: [...], instructions: [...] }
const EXDB_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';
const EXDB_JSON = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/refs/heads/main/dist/exercises.json';

async function loadExerciseDB() {
  try {
    const res = await fetch(EXDB_JSON);
    const data = await res.json();
    data.forEach(ex => {
      EXDB[ex.name.toLowerCase()] = {
        id: ex.id,
        images: ex.images.map(p => EXDB_BASE + p),
        instructions: ex.instructions || []
      };
    });
    renderExercises(); // re-render now that images are available
  } catch (e) {
    console.warn('Exercise DB load failed:', e);
  }
}

// Find a DB entry for an exercise by name — exact match first, then fuzzy.
function dbLookup(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  if (EXDB[key]) return EXDB[key];

  const keys = Object.keys(EXDB);
  const words = key.split(/\s+/).filter(w => w.length > 2);

  // Tier 1: DB entry whose name contains ALL words from our exercise name.
  // Prefer shorter DB names (closest match) to avoid over-broad matches.
  const allMatch = keys.filter(k => words.every(w => k.includes(w)));
  if (allMatch.length) {
    allMatch.sort((a, b) => a.length - b.length);
    return EXDB[allMatch[0]];
  }

  // Tier 2: starts with first word AND contains second word.
  if (words.length >= 2) {
    const tier2 = keys.filter(k => k.startsWith(words[0]) && k.includes(words[1]));
    if (tier2.length) {
      tier2.sort((a, b) => a.length - b.length);
      return EXDB[tier2[0]];
    }
  }

  return null;
}
