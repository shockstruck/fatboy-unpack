import fs from "node:fs";
import { join } from "node:path";

// Progress signals for installers that produce no output: a silent Inno Setup
// run only shows up as the installation directory growing on disk. See
// docs/silent-install-progress-research.md for why /LOG and unarc offer no
// machine-readable alternative.

/** Total size in bytes of all regular files under dir, tolerating churn. */
export function directorySize(dir: string): number {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let total = 0;
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		try {
			if (entry.isDirectory()) {
				total += directorySize(fullPath);
			} else if (entry.isFile()) {
				total += fs.statSync(fullPath).size;
			}
		} catch {
			// The installer moves files while we measure; skip what vanished.
		}
	}
	return total;
}

export type InstallPhase = "extracting" | "verifying";

export type InstallProgressUpdate = {
	/** 0-99; never 100 — completion is the installer exiting, not a byte count. */
	progress: number;
	phase: InstallPhase;
};

/**
 * How many consecutive flat polls before we call the install "verifying".
 * FitGirl installers end with a CRC pass that reads files without growing the
 * directory, so sustained flatness late in the install means verification.
 */
const FLAT_POLLS_FOR_VERIFY = 6;

/**
 * Polls dir and reports its size as a fraction of expectedBytes, plus a phase:
 * once growth stalls for a sustained stretch the install is presumed to be in
 * its CRC-verification tail and the phase flips to "verifying" (and back, if
 * writing resumes). Progress is monotonic and capped at 99; the caller reports
 * 100 only when the installer process exits successfully.
 */
export function trackInstallProgress(
	dir: string,
	expectedBytes: number,
	onUpdate: (update: InstallProgressUpdate) => void,
	intervalMs = 5_000,
): () => void {
	let lastProgress = -1;
	let lastSize = -1;
	let flatPolls = 0;
	let phase: InstallPhase = "extracting";
	const report = (): void => {
		const size = directorySize(dir);
		if (size > lastSize) {
			lastSize = size;
			flatPolls = 0;
		} else {
			flatPolls += 1;
		}
		const nextPhase: InstallPhase =
			flatPolls >= FLAT_POLLS_FOR_VERIFY && lastSize > 0
				? "verifying"
				: "extracting";
		const progress = Math.min(
			99,
			Math.floor((size / Math.max(expectedBytes, 1)) * 100),
		);
		if (progress > lastProgress || nextPhase !== phase) {
			lastProgress = Math.max(lastProgress, progress);
			phase = nextPhase;
			onUpdate({ progress: lastProgress, phase });
		}
	};
	report();
	const timer = setInterval(report, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
