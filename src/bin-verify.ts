import crypto from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";

// Native replacement for the repack's "Verify BIN files before installation"
// step. FitGirl ships MD5/fitgirl-bins.md5 (md5sum format) and a .bat that
// opens it in QuickSFV's GUI; hashing the manifest ourselves gives the same
// integrity check with progress and no window to dismiss.

export type Md5Entry = {
	/** Lowercase 32-hex digest from the manifest. */
	hash: string;
	/** Filename as written in the manifest, separators normalized to "/". */
	name: string;
};

export type BinVerificationResult = {
	verified: number;
	/** Manifest names whose file hashed differently than the manifest says. */
	corrupt: string[];
	/** Manifest names with no file on disk (e.g. excluded optional bins). */
	missing: string[];
};

/** Parses md5sum-format lines: "<32 hex> [*]filename". ";" lines are comments. */
export function parseMd5Manifest(content: string): Md5Entry[] {
	const entries: Md5Entry[] = [];
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith(";")) continue;
		const match = trimmed.match(/^([0-9a-fA-F]{32})\s+\*?(.+)$/);
		if (!match) continue;
		entries.push({
			hash: match[1].toLowerCase(),
			name: match[2].trim().replaceAll("\\", "/"),
		});
	}
	return entries;
}

/** The repack's bin manifest beside setup.exe, or undefined when not shipped. */
export function findBinManifest(setupDir: string): string | undefined {
	const candidates = [
		join(setupDir, "MD5", "fitgirl-bins.md5"),
		join(setupDir, "fitgirl-bins.md5"),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	// Renamed manifests still follow the .md5 convention; take the first found.
	for (const dir of [join(setupDir, "MD5"), setupDir]) {
		try {
			const md5 = fs
				.readdirSync(dir)
				.find((file) => file.toLowerCase().endsWith(".md5"));
			if (md5) return join(dir, md5);
		} catch {
			// No such directory.
		}
	}
	return undefined;
}

function md5File(path: string, onBytes: (bytes: number) => void): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("md5");
		fs.createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })
			.on("data", (chunk: Buffer) => {
				hash.update(chunk);
				onBytes(chunk.length);
			})
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});
}

/**
 * Hashes every manifest entry it can find on disk and reports 0-100 progress
 * by bytes. Manifest names resolve against the manifest's directory, then the
 * setup directory (QuickSFV resolves against the .md5 location, but FitGirl
 * lists the bins that live one level up, beside setup.exe). Missing files are
 * reported, not failed: excluded optional bins are legitimately absent.
 */
export async function verifyRepackBins(
	manifestPath: string,
	onProgress?: (progress: number) => void,
): Promise<BinVerificationResult> {
	const manifestDir = dirname(manifestPath);
	const setupDir = dirname(manifestDir);
	const entries = parseMd5Manifest(fs.readFileSync(manifestPath, "utf-8"));

	const targets: { entry: Md5Entry; path: string; size: number }[] = [];
	const missing: string[] = [];
	for (const entry of entries) {
		const path = [
			join(manifestDir, entry.name),
			join(setupDir, entry.name),
			join(setupDir, basename(entry.name)),
		].find((candidate) => fs.existsSync(candidate));
		if (!path) {
			missing.push(entry.name);
			continue;
		}
		targets.push({ entry, path, size: fs.statSync(path).size });
	}

	const totalBytes = Math.max(
		targets.reduce((total, target) => total + target.size, 0),
		1,
	);
	let doneBytes = 0;
	let lastReported = -1;
	const corrupt: string[] = [];
	for (const target of targets) {
		const digest = await md5File(target.path, (bytes) => {
			doneBytes += bytes;
			const progress = Math.min((doneBytes / totalBytes) * 100, 100);
			if (progress >= lastReported + 1) {
				lastReported = progress;
				onProgress?.(progress);
			}
		});
		if (digest !== target.entry.hash) {
			corrupt.push(target.entry.name);
		}
	}
	onProgress?.(100);
	return { verified: targets.length - corrupt.length, corrupt, missing };
}
