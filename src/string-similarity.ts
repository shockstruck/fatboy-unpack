import { SearchTool } from "ogi-addon";

export type Game = {
  name: string,
  url: string,
}

function normalizeGameName(name: string): string {
  let processedName = name.toLowerCase();

  // 1. Remove bracketed content (e.g., [FitGirl], (Legacy))
  processedName = processedName.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '');

  // 2. Remove versioning, builds, and other metadata
  processedName = processedName.replace(/v\d+(\.\d+)*(\/\d+(\.\d+)*)?/g, ''); // v1.0.3411/1.70
  processedName = processedName.replace(/build\s*\d+(\.\d+)*/gi, ''); // Build 1491.50
  processedName = processedName.replace(/\+\s*\d+\s*dlcs?/gi, ''); // + 9 DLCs
  processedName = processedName.replace(/\+\s*[\w\s]+/gi, ''); // + Bonus Content, + Windows 7 Fix

  // 3. Handle primary title separation, taking the part before a delimiter
  const mainTitleMatch = processedName.match(/^(.+?)(?:\s*[:–—]|\s+-\s+)/);
  if (mainTitleMatch) {
    processedName = mainTitleMatch[1];
  }

  // 4. Handle alternative titles separated by '/'
  if (processedName.includes('/')) {
    processedName = processedName.split('/')[0];
  }

  // 5. Remove common edition/bundle keywords
  const keywordsToRemove = [
    'ultimate edition', 'deluxe edition', 'anniversary edition', 'medley of pain bundle',
    'shadow of the erdtree', 'enhanced', 'legacy'
  ];
  keywordsToRemove.forEach(keyword => {
    processedName = processedName.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), '');
  });

  // 6. Final cleanup: remove non-alphanumeric chars (except spaces) and trim
  processedName = processedName.replace(/[^a-z0-9\s]/g, '');
  processedName = processedName.replace(/\s+/g, ' ').trim();

  return processedName;
}

export function findBestGameMatch(searchTerm: string, games: Game[], search: SearchTool<Game>): Game | null {
  if (!games || games.length === 0) {
    return null;
  }

  const normalizedSearchTerm = normalizeGameName(searchTerm);
  if (!normalizedSearchTerm) {
    return null; // Don't search for empty strings
  }

  const candidates = games
    .map(game => {
      const normalizedGameName = normalizeGameName(game.name);
      
      if (normalizedGameName.toLowerCase().includes('switch emulators')) {
        return { game, score: 0}
      }

      // Calculate a similarity score
      let score = 0;
      if (normalizedGameName === normalizedSearchTerm) {
        score = 1; // Perfect match
      } else if (normalizedGameName.includes(normalizedSearchTerm) || normalizedSearchTerm.includes(normalizedGameName)) {
        const longer = Math.max(normalizedGameName.length, normalizedSearchTerm.length);
        const shorter = Math.min(normalizedGameName.length, normalizedSearchTerm.length);
        if (longer > 0) {
          score = shorter / longer; // Simple ratio
        }
      }

      return { game, score };
    })
    .filter(c => c.score > 0.8); // Set a threshold, e.g., 80% similarity on normalized names

  if (candidates.length > 0) {
    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    console.log(`Best match for "${searchTerm}": "${candidates[0].game.name}" (score: ${candidates[0].score})`);
    return candidates[0].game;
  }

  // Fallback to fuzzy search if no good match is found
  const fuzzyResults = search.search(searchTerm);
  if (fuzzyResults.length > 0) {
      console.log(`Using fuzzy match for "${searchTerm}": "${fuzzyResults[0].name}"`);
      return fuzzyResults[0];
  }

  return null;
}
