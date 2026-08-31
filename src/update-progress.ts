import fs from "node:fs";
import { directorySize } from "./install-progress";

// Live activity for one silent updater run. A FitGirl/ElAmigos updater leaves
// two real signals while it works: its Inno /LOG file (file entries, then
// postinstall [Run] launches of batch.bat and RapidCRC) and the target
// directory growing while hpatchz writes patched files. Neither yields an
// exact fraction, so callers render the activity plus a bounded monotone
// estimate — never a bar stuck at one value for the whole run.

export type UpdaterPhase = "starting" | "installing" | "patching" | "verifying";

export type UpdaterActivity = {
	phase: UpdaterPhase;
	/** Files the Inno stage has installed so far. */
	filesInstalled: number;
	/** How much the target directory has grown since the step began. */
	bytesWritten: number;
};

/** Phase and file count from the updater's Inno log content. */
export function parseUpdaterLog(
	content: string,
): Pick<UpdaterActivity, "phase" | "filesInstalled"> {
	const filesInstalled = (content.match(/-- File entry --/g) ?? []).length;
	// The postinstall [Run] entries appear in execution order: batch.bat drives
	// hpatchz (the actual patching), RapidCRC verifies afterwards.
	let phase: UpdaterPhase = filesInstalled > 0 ? "installing" : "starting";
	for (const block of content.split("-- Run entry --").slice(1)) {
		const target = block.match(/Filename: (.*)/)?.[1] ?? "";
		phase = /rapidcrc/i.test(target) ? "verifying" : "patching";
	}
	return { phase, filesInstalled };
}

// Half-way constants for the saturating estimates below: an updater that has
// installed 25 files or patched 2 GiB shows half of its phase's band.
const INSTALL_COUNT_HALFWAY = 25;
const PATCH_BYTES_HALFWAY = 2 * 1024 ** 3;

/**
 * Maps activity to a 0..1 step fraction. Phases own fixed bands (installing
 * 5-25%, patching 25-95%) and saturate toward their end instead of guessing a
 * total, so progress is monotone and honest about being an estimate.
 */
export function updaterStepFraction(activity: UpdaterActivity): number {
	switch (activity.phase) {
		case "starting":
			return 0.02;
		case "installing":
			return (
				0.05 +
				0.2 *
					(activity.filesInstalled /
						(activity.filesInstalled + INSTALL_COUNT_HALFWAY))
			);
		case "patching":
			return (
				0.25 +
				0.7 *
					(activity.bytesWritten /
						(activity.bytesWritten + PATCH_BYTES_HALFWAY))
			);
		case "verifying":
			return 0.97;
	}
}

/**
 * One-line activity description for the OGI log pane. Whole-GiB buckets keep
 * the patching phase to roughly one line per written gibibyte.
 */
export function describeUpdaterActivity(
	label: string,
	activity: UpdaterActivity,
): string {
	switch (activity.phase) {
		case "starting":
			return `Update ${label}: starting installer...`;
		case "installing":
			return `Update ${label}: unpacking update files...`;
		case "patching": {
			const gib = Math.floor(activity.bytesWritten / 1024 ** 3);
			return `Update ${label}: patching game files (${gib} GiB written)...`;
		}
		case "verifying":
			return `Update ${label}: verifying patched files...`;
	}
}

/**
 * Polls the installer log and target directory while an updater runs and
 * reports activity whenever it changes. bytesWritten is the peak growth over
 * the step's starting size, so temp-file cleanup never moves progress
 * backwards. Returns a stop function.
 */
export function trackUpdaterActivity(
	logFile: string,
	targetDir: string,
	onActivity: (activity: UpdaterActivity) => void,
	intervalMs = 5_000,
): () => void {
	let baselineSize: number | undefined;
	let bytesWritten = 0;
	let lastKey = "";
	const report = (): void => {
		let content = "";
		try {
			content = fs.readFileSync(logFile, "utf-8");
		} catch {
			// The installer has not created its log yet.
		}
		const { phase, filesInstalled } = parseUpdaterLog(content);
		const size = directorySize(targetDir);
		baselineSize ??= size;
		bytesWritten = Math.max(bytesWritten, size - baselineSize);
		const key = `${phase}:${filesInstalled}:${Math.floor(bytesWritten / (256 * 1024 ** 2))}`;
		if (key === lastKey) return;
		lastKey = key;
		onActivity({ phase, filesInstalled, bytesWritten });
	};
	report();
	const timer = setInterval(report, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
