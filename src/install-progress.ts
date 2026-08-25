import fs from "node:fs";
import { join } from "node:path";

// Progress signals for installers that produce no output: a silent Inno Setup
// run only shows up as the installation directory growing on disk.

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

/**
 * Polls dir and reports its size as a percentage of expectedBytes. The
 * estimate can undershoot the real final size, so progress holds at 99;
 * completion is signaled by the installer exiting, not by this watch.
 */
export function trackDirectoryGrowth(
	dir: string,
	expectedBytes: number,
	onProgress: (progress: number) => void,
	intervalMs = 5_000,
): () => void {
	let last = -1;
	const report = (): void => {
		const progress = Math.min(
			99,
			Math.floor((directorySize(dir) / Math.max(expectedBytes, 1)) * 100),
		);
		if (progress > last) {
			last = progress;
			onProgress(progress);
		}
	};
	report();
	const timer = setInterval(report, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
