import { SearchTool } from "ogi-addon";

export type Game = {
  name: string,
  url: string,
}

export type MatchOptions = {
  ignoreHypervisor?: boolean;
}

function normalizeGameName(name: string): string {
  let processedName = name.toLowerCase();

  // SteamRIP-style cleanup
  processedName = processedName
    // Remove common download-related suffixes
    .replace(/\s+(free\s+)?download.*$/i, '')
    // Remove version patterns like (v1.2.3), [v1.2.3], etc.
    .replace(/[\(\[\{]v?[\d\.]+[\)\]\}]/gi, '')
    // Remove year patterns like (2023), [2024], etc.
    .replace(/[\(\[\{]\d{4}[\)\]\}]/g, '')
    // Remove edition suffixes but keep the base game title for matching
    .replace(/\s+(premium|deluxe|gold|ultimate|complete|goty|game\s+of\s+the\s+year|enhanced|definitive|remastered|directors?\s+cut)\s+(edition)?/gi, '');

  // FitGirl-specific quirks/metadata cleanup
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

  // 5. Remove common FitGirl edition/bundle keywords
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

function calculateCharacterOverlap(str1: string, str2: string): number {
  if (str1.length < 2 || str2.length < 2) return str1 === str2 ? 1 : 0;

  const bigrams1 = new Set<string>();
  const bigrams2 = new Set<string>();

  for (let i = 0; i < str1.length - 1; i++) {
    bigrams1.add(str1.substring(i, i + 2));
  }

  for (let i = 0; i < str2.length - 1; i++) {
    bigrams2.add(str2.substring(i, i + 2));
  }

  const intersection = [...bigrams1].filter(bg => bigrams2.has(bg)).length;
  const union = bigrams1.size + bigrams2.size - intersection;

  return union > 0 ? intersection / union : 0;
}

function stringSimilarity(a: string, b: string): number {
  const cleanA = normalizeGameName(a);
  const cleanB = normalizeGameName(b);

  if (cleanA === cleanB) return 1;

  const wordsA = cleanA.split(/\s+/).filter(word => word.length > 0);
  const wordsB = cleanB.split(/\s+/).filter(word => word.length > 0);

  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  let exactMatches = 0;
  let partialMatches = 0;
  const usedWordsB = new Set<number>();

  for (const wordA of wordsA) {
    let bestMatch = 0;
    let bestMatchIndex = -1;

    for (let i = 0; i < wordsB.length; i++) {
      if (usedWordsB.has(i)) continue;

      const wordB = wordsB[i];

      if (wordA === wordB) {
        exactMatches++;
        usedWordsB.add(i);
        bestMatchIndex = i;
        break;
      }

      const overlap = calculateCharacterOverlap(wordA, wordB);
      if (overlap > bestMatch && overlap > 0.6) {
        bestMatch = overlap;
        bestMatchIndex = i;
      }
    }

    if (bestMatchIndex !== -1 && !usedWordsB.has(bestMatchIndex) && bestMatch > 0) {
      partialMatches++;
      usedWordsB.add(bestMatchIndex);
    }
  }

  const totalWords = Math.max(wordsA.length, wordsB.length);
  const exactScore = exactMatches / totalWords;
  const partialScore = (partialMatches * 0.7) / totalWords;

  return Math.min(1, exactScore + partialScore);
}

function isIgnoredGame(game: Game, options?: MatchOptions): boolean {
  if (options?.ignoreHypervisor && /\bhypervisor\b/i.test(game.name)) {
    return true;
  }

  return normalizeGameName(game.name).includes('switch emulators');
}

export function findBestGameMatch(searchTerm: string, games: Game[], search: SearchTool<Game>, options?: MatchOptions): Game | null {
  if (!games || games.length === 0) {
    return null;
  }

  const filteredGames = games.filter(game => !isIgnoredGame(game, options));
  if (filteredGames.length === 0) {
    return null;
  }

  let bestMatch: Game | null = null;
  let bestScore = 0;

  for (const candidate of filteredGames) {
    const score = stringSimilarity(candidate.name, searchTerm);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  const SIMILARITY_THRESHOLD = 0.4;
  if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
    console.log(`Best match for "${searchTerm}": "${bestMatch.name}" (score: ${bestScore})`);
    return bestMatch;
  }

  const fuzzyResults = search.search(searchTerm).filter(game => !isIgnoredGame(game, options));
  if (fuzzyResults.length > 0) {
    console.log(`Using fuzzy match for "${searchTerm}": "${fuzzyResults[0].name}"`);
    return fuzzyResults[0];
  }

  return null;
}
