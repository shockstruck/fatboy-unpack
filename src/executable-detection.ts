import { basename, join, relative } from "node:path";
import { open, readdir, stat } from "node:fs/promises";
import { scoreTitleSimilarity } from "./string-similarity";

/**
 * Top-level directories that are common installer noise, not the game
 * itself. Case-insensitive.
 */
export const NOISE_DIRS = new Set([
  "_commonredist",
  "_redist",
  "redist",
  "__macosx",
  "_setup",
]);

export function isNoiseDir(name: string): boolean {
  return NOISE_DIRS.has(name.toLowerCase());
}

export interface FolderEntry {
  name: string;
  isDirectory: boolean;
}

export type FolderDecision =
  | { action: "flat" }
  | { action: "collapse"; targetDir: string }
  | { action: "ambiguous" };

/**
 * Decides whether the download folder can be reduced to a single game
 * folder without asking the user. Pure: takes a directory listing, not a
 * filesystem.
 */
export function decideGameFolder(
  entries: FolderEntry[],
  archiveFileNames: string[],
): FolderDecision {
  const archiveNamesLower = new Set(
    archiveFileNames.map((name) => name.toLowerCase()),
  );
  const dirs = entries.filter((entry) => entry.isDirectory);
  const files = entries.filter((entry) => !entry.isDirectory);
  const nonNoiseDirs = dirs.filter((dir) => !isNoiseDir(dir.name));
  const looseFiles = files.filter(
    (file) => !archiveNamesLower.has(file.name.toLowerCase()),
  );

  if (nonNoiseDirs.length === 0) {
    return { action: "flat" };
  }
  if (nonNoiseDirs.length === 1 && looseFiles.length === 0) {
    return { action: "collapse", targetDir: nonNoiseDirs[0].name };
  }
  return { action: "ambiguous" };
}

// --- Blocklist -------------------------------------------------------

const BLOCKLIST_GLOBS = [
  "unitycrashhandler*",
  "unins*",
  "*redist*",
  "vc_redist*",
  "dxsetup*",
  "dxwebsetup*",
  "crashpad*",
  "crashreport*",
  "ue4prereqsetup*",
  "ueprereqsetup*",
  "*_be.exe",
  "easyanticheat*",
  "dotnet*setup*",
];

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

const BLOCKLIST_PATTERNS = BLOCKLIST_GLOBS.map(globToRegExp);

const BLOCKED_PATH_PATTERNS = [
  /(^|\/)Engine\/Extras(\/|$)/i,
  /(^|\/)Engine\/Binaries\/ThirdParty(\/|$)/i,
  /(^|\/)Engine\/Binaries\/Win64\/[^/]*CrashReport[^/]*(\/|$)/i,
];

export function isBlockedExecutable(fileName: string): boolean {
  return BLOCKLIST_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function isBlockedPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  if (segments.some((segment) => isNoiseDir(segment))) return true;
  const normalized = segments.join("/");
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

// --- PE header ---------------------------------------------------------

export interface PEInfo {
  machine: number;
  isDll: boolean;
  subsystem: number;
}

const IMAGE_FILE_DLL = 0x2000;
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;

export const MACHINE_X64 = 0x8664;
export const MACHINE_X86 = 0x14c;

/**
 * Parses just enough of a PE header to tell a real GUI executable apart
 * from a DLL, a console tool or garbage. Pure: takes a buffer, not a path.
 */
export function parsePEHeader(buffer: Buffer): PEInfo | null {
  if (buffer.length < 0x40) return null;
  if (buffer.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"

  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 24 > buffer.length) return null;
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return null; // "PE\0\0"

  const machine = buffer.readUInt16LE(peOffset + 4);
  const characteristics = buffer.readUInt16LE(peOffset + 22);

  const optionalHeaderOffset = peOffset + 24;
  if (optionalHeaderOffset + 70 > buffer.length) return null;
  const subsystem = buffer.readUInt16LE(optionalHeaderOffset + 68);

  return {
    machine,
    isDll: (characteristics & IMAGE_FILE_DLL) !== 0,
    subsystem,
  };
}

export function isValidExecutable(pe: PEInfo | null): boolean {
  if (!pe) return false;
  if (pe.isDll) return false;
  if (pe.subsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI) return false;
  return true;
}

// --- Scoring -------------------------------------------------------------

export interface ExecutableCandidate {
  relPath: string;
  size: number;
  pe: PEInfo | null;
}

export interface ScoredCandidate extends ExecutableCandidate {
  score: number;
  depth: number;
}

const LAUNCHER_PENALTY = 0.35;
const MACHINE_BIAS = 0.02;

/**
 * Scores and filters a flat list of candidate executables. Pure: takes
 * plain records, not a filesystem, so it is unit-testable on its own.
 */
export function scoreCandidates(
  candidates: ExecutableCandidate[],
  gameName: string,
  parentFolderName: string,
): ScoredCandidate[] {
  const valid = candidates.filter(
    (candidate) =>
      isValidExecutable(candidate.pe) &&
      !isBlockedPath(candidate.relPath) &&
      !isBlockedExecutable(basename(candidate.relPath)),
  );

  const scored = valid.map((candidate) => {
    const base = basename(candidate.relPath).replace(/\.exe$/i, "");
    const nameScore = scoreTitleSimilarity(base, gameName);
    const folderScore = scoreTitleSimilarity(base, parentFolderName);
    let score = Math.max(nameScore, folderScore);

    if (/launcher/i.test(base)) {
      score = Math.max(0, score - LAUNCHER_PENALTY);
    }

    if (candidate.pe?.machine === MACHINE_X64) {
      score += MACHINE_BIAS;
    } else if (candidate.pe?.machine === MACHINE_X86) {
      score -= MACHINE_BIAS;
    }

    const depth = candidate.relPath.split(/[\\/]/).length - 1;
    return { ...candidate, score, depth };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.size !== a.size) return b.size - a.size;
    return a.depth - b.depth;
  });

  return scored;
}

export interface ExecutableChoice {
  autoPick: ScoredCandidate | null;
  ranked: ScoredCandidate[];
}

const CONFIDENCE_MARGIN = 0.3;

/**
 * Decides whether scored candidates are confident enough to auto-pick, or
 * whether the user still needs to choose. Never picks silently below the
 * margin.
 */
export function resolveExecutableChoice(
  scored: ScoredCandidate[],
): ExecutableChoice {
  if (scored.length === 0) return { autoPick: null, ranked: [] };
  if (scored.length === 1) return { autoPick: scored[0], ranked: scored };

  const [top, second] = scored;
  if (top.score - second.score >= CONFIDENCE_MARGIN) {
    return { autoPick: top, ranked: scored };
  }
  return { autoPick: null, ranked: scored };
}

// --- Filesystem scan -------------------------------------------------

/**
 * Walks `root` up to `maxDepth` levels below it, collecting `.exe` files
 * with just enough of their header read to classify them. Skips noise
 * directories and blocklisted paths/names outright.
 */
export async function scanExecutables(
  root: string,
  maxDepth = 4,
): Promise<ExecutableCandidate[]> {
  const results: ExecutableCandidate[] = [];

  async function readHeader(filePath: string): Promise<PEInfo | null> {
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return parsePEHeader(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (isNoiseDir(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".exe")) continue;

      const relPath = relative(root, full);
      if (isBlockedPath(relPath)) continue;
      if (isBlockedExecutable(entry.name)) continue;

      try {
        const [{ size }, pe] = await Promise.all([
          stat(full),
          readHeader(full),
        ]);
        results.push({ relPath, size, pe });
      } catch {
        continue;
      }
    }
  }

  await walk(root, 0);
  return results;
}

export function candidateAbsolutePath(root: string, relPath: string): string {
  return join(root, relPath);
}
