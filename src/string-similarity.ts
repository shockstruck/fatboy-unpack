import type { SearchTool } from "ogi-addon";

export type Game = {
  name: string;
  url: string;
};

export type MatchOptions = {
  ignoreHypervisor?: boolean;
};

type TitleAlias = {
  normalized: string;
  numeric: string;
};

type RankedGame = {
  game: Game;
  score: number;
};

const MATCH_THRESHOLD = 0.72;
const ROMAN_NUMERAL_PATTERN =
  /^(?:xxxix|xxxviii|xxxvii|xxxvi|xxxv|xxxiv|xxxiii|xxxii|xxxi|xxx|xxix|xxviii|xxvii|xxvi|xxv|xxiv|xxiii|xxii|xxi|xx|xix|xviii|xvii|xvi|xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)$/i;

const LOW_WEIGHT_WORDS = new Set([
  "a",
  "an",
  "and",
  "bundle",
  "collection",
  "complete",
  "deluxe",
  "digital",
  "edition",
  "for",
  "game",
  "gold",
  "in",
  "of",
  "on",
  "the",
  "to",
  "ultimate",
  "with",
  "year",
]);

const titleAliasCache = new WeakMap<Game, TitleAlias[]>();

function romanToNumber(value: string): number | null {
  if (!ROMAN_NUMERAL_PATTERN.test(value)) {
    return null;
  }

  const values: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
  };
  let total = 0;
  let previous = 0;

  for (const character of value.toLowerCase().split("").reverse()) {
    const current = values[character];
    if (current < previous) {
      total -= current;
    } else {
      total += current;
      previous = current;
    }
  }

  return total;
}

function replaceRomanNumerals(value: string): string {
  return value
    .split(" ")
    .map((token) => romanToNumber(token)?.toString() ?? token)
    .join(" ");
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/(\d)\s*[-/]\s*(\d)/g, "$1 $2")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripRepackMetadata(value: string): string {
  return value
    .replace(
      /\s+-\s+(?=(?:v\.?\d|build(?:id)?\b|steam\s+build\b|release\s+v\b|patch\b|update\b|final\s+repack\b)).*$/i,
      "",
    )
    .replace(
      /,\s*(?=(?:v\.?\d|build(?:id)?\b|steam\s+build\b|chapters?\s+[ivx\d])).*$/i,
      "",
    )
    .replace(
      /\s+\+\s+(?=(?:(?:all\s+)?\d+\s+)?(?:dlcs?|bonuses?|osts?|soundtracks?|add-ons?)\b|bonus\b|windows\s+\d+\s+fix\b|online\b|multiplayer\b|yuzu\b|ryujinx\b|switch\s+emulators?\b|controller\s+fix\b|unlocker\b|fix(?:es)?\b|crackfix\b|mods?\b|hd\s+textures?\b|font\s+fixes?\b|patch\b|update\b).*$/i,
      "",
    )
    .replace(/\s+v\.?\d[\w.-]*(?:\/[\w.-]+)*(?:\s+.*)?$/i, "")
    .replace(
      /\s*\((?=[^)]*(?:v\d|build|update|repack|denuvoless|emulator|crack))[^)]*\)/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function addFallbackAliases(value: string, aliases: Set<string>): void {
  const withoutParentheticalQualifiers = value
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutParentheticalQualifiers !== value) {
    aliases.add(withoutParentheticalQualifiers);
  }

  const withoutEdition = value
    .replace(
      /(?:\s*[:,-]\s*|\s+)(?:(?:digital|super)\s+)?(?:anniversary|anthology|collector'?s|complete|definitive|deluxe|enhanced|game\s+of\s+the\s+year|gold|goty|premium|re-elected|remastered|resolute|royal|ultimate|xxl)(?:\s+(?:bundle|collection|edition))?$/i,
      "",
    )
    .trim();
  if (withoutEdition !== value) {
    aliases.add(withoutEdition);
  }
}

function titleAliases(game: Game): TitleAlias[] {
  const cached = titleAliasCache.get(game);
  if (cached) {
    return cached;
  }

  const strippedName = stripRepackMetadata(game.name);
  const rawAliases = new Set<string>([strippedName]);
  addFallbackAliases(strippedName, rawAliases);

  for (const alias of strippedName.split(/\s+\/\s+/)) {
    rawAliases.add(alias);
    addFallbackAliases(alias, rawAliases);
  }

  try {
    const slug = new URL(game.url).pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/-(?:pc|switch)$/, "");
    if (slug) {
      rawAliases.add(slug.replace(/-/g, " "));
    }
  } catch {
    // A malformed URL should not make an otherwise valid catalog entry unusable.
  }

  const aliases = new Map<string, TitleAlias>();
  for (const alias of rawAliases) {
    const normalized = normalizeTitle(alias);
    if (!normalized) {
      continue;
    }

    const numeric = replaceRomanNumerals(normalized);
    aliases.set(`${normalized}\0${numeric}`, { normalized, numeric });
  }

  const result = [...aliases.values()];
  titleAliasCache.set(game, result);
  return result;
}

function tokenWeight(token: string): number {
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    return 2.5;
  }
  return LOW_WEIGHT_WORDS.has(token) ? 0.25 : 1;
}

function significantNumbers(value: string): Set<string> {
  return new Set(
    value
      .split(" ")
      .filter((token) => /^\d+(?:\.\d+)?$/.test(token))
      .filter((token) => {
        const number = Number(token);
        return !Number.isInteger(number) || number < 1900 || number > 2099;
      }),
  );
}

function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) {
    return 1;
  }
  if (left.length < 2 || right.length < 2) {
    return 0;
  }

  const leftPairs = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index++) {
    const pair = left.slice(index, index + 2);
    leftPairs.set(pair, (leftPairs.get(pair) ?? 0) + 1);
  }

  let intersection = 0;
  for (let index = 0; index < right.length - 1; index++) {
    const pair = right.slice(index, index + 2);
    const count = leftPairs.get(pair) ?? 0;
    if (count > 0) {
      intersection++;
      leftPairs.set(pair, count - 1);
    }
  }

  return (2 * intersection) / (left.length + right.length - 2);
}

function orderedTokenCoverage(left: string[], right: string[]): number {
  const rows = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      rows[leftIndex][rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? rows[leftIndex - 1][rightIndex - 1] + 1
          : Math.max(
              rows[leftIndex - 1][rightIndex],
              rows[leftIndex][rightIndex - 1],
            );
    }
  }

  return rows[left.length][right.length] / Math.max(left.length, right.length);
}

function weightedTokenScore(left: string[], right: string[]): number {
  const leftTokens = new Set(left);
  const rightTokens = new Set(right);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  const sharedWeight = shared.reduce(
    (total, token) => total + tokenWeight(token),
    0,
  );
  const leftWeight = [...leftTokens].reduce(
    (total, token) => total + tokenWeight(token),
    0,
  );
  const rightWeight = [...rightTokens].reduce(
    (total, token) => total + tokenWeight(token),
    0,
  );

  if (leftWeight === 0 || rightWeight === 0) {
    return 0;
  }

  const leftCoverage = sharedWeight / leftWeight;
  const rightCoverage = sharedWeight / rightWeight;
  return leftCoverage * 0.6 + rightCoverage * 0.4;
}

function scoreAlias(searchAlias: TitleAlias, candidateAlias: TitleAlias): number {
  if (searchAlias.normalized === candidateAlias.normalized) {
    return 1;
  }
  if (searchAlias.numeric === candidateAlias.numeric) {
    return 0.99;
  }

  const searchNumbers = significantNumbers(searchAlias.numeric);
  const candidateNumbers = significantNumbers(candidateAlias.numeric);
  if (
    searchNumbers.size > 0 &&
    candidateNumbers.size > 0 &&
    !setsEqual(searchNumbers, candidateNumbers)
  ) {
    return 0;
  }

  const searchTokens = searchAlias.numeric.split(" ");
  const candidateTokens = candidateAlias.numeric.split(" ");
  const tokenScore = weightedTokenScore(searchTokens, candidateTokens);
  const characterScore = diceCoefficient(
    searchAlias.numeric,
    candidateAlias.numeric,
  );
  const orderScore = orderedTokenCoverage(searchTokens, candidateTokens);

  let score = tokenScore * 0.55 + characterScore * 0.3 + orderScore * 0.15;

  // A missing sequel number is a material title difference, not a minor typo.
  if (
    (searchNumbers.size === 0) !== (candidateNumbers.size === 0) &&
    score > 0.69
  ) {
    score = 0.69;
  }

  return score;
}

function scoreGame(searchAliases: TitleAlias[], game: Game): number {
  let bestScore = 0;
  for (const searchAlias of searchAliases) {
    for (const candidateAlias of titleAliases(game)) {
      bestScore = Math.max(bestScore, scoreAlias(searchAlias, candidateAlias));
    }
  }
  return bestScore;
}

function isIgnoredGame(game: Game, options?: MatchOptions): boolean {
  if (options?.ignoreHypervisor && /\bhypervisor\b/i.test(game.name)) {
    return true;
  }

  return (
    /\bswitch emulators?\b/i.test(game.name) ||
    /\s+-\s+(?:patch|update)\s+(?:from|for)\b/i.test(game.name)
  );
}

export function findBestGameMatch(
  searchTerm: string,
  games: Game[],
  _search: SearchTool<Game>,
  options?: MatchOptions,
): Game | null {
  if (!games?.length) {
    return null;
  }

  const searchAliases = titleAliases({ name: searchTerm, url: "" });
  if (searchAliases.length === 0) {
    return null;
  }

  let bestMatch: RankedGame | null = null;
  for (const game of games) {
    if (isIgnoredGame(game, options)) {
      continue;
    }

    const score = scoreGame(searchAliases, game);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { game, score };
    }
  }

  if (!bestMatch || bestMatch.score < MATCH_THRESHOLD) {
    return null;
  }

  console.log(
    `Best match for "${searchTerm}": "${bestMatch.game.name}" (score: ${bestMatch.score.toFixed(3)})`,
  );
  return bestMatch.game;
}
