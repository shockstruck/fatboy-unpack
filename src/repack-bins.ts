import fs from "node:fs";
import { basename, join } from "node:path";

// FitGirl repacks ship their payload as fg-*.bin files beside setup.exe, and
// the installer treats presence as availability: a selective or optional bin
// that is missing simply cannot be installed. Sniffing the bins reveals what
// a repack offers, and moving a bin aside deselects it during a silent
// install without having to know the repack's installer component names.

export type SelectiveBinGroup = {
	/** Group key from the filename, e.g. "english" for fg-selective-english.bin. */
	key: string;
	/** Combined size of the group's parts in bytes. */
	size: number;
};

export type OptionalBinGroup = {
	key: string;
	/** Human-readable label, e.g. "Bonus Content" for fg-optional-bonus-content.bin. */
	label: string;
	/** Absolute paths of the group's parts. */
	files: string[];
	size: number;
};

export type RepackBins = {
	/** Combined size of the numbered fg-NN.bin payloads in bytes. */
	requiredSize: number;
	requiredCount: number;
	/** Selective content present; the installer includes it automatically. */
	selective: SelectiveBinGroup[];
	/** Optional content the user may exclude. */
	optional: OptionalBinGroup[];
};

const REQUIRED_BIN = /^fg-\d+\.bin$/i;
const OPTIONAL_BIN = /^fg-optional-(.+)\.bin$/i;
const SELECTIVE_BIN = /^fg-selective-(.+)\.bin$/i;
const EXCLUDED_DIR = "fatboy-excluded-bins";

/** Multi-part bins end in "-2", "-3", ...; they belong to the first part's group. */
function groupKey(suffix: string): string {
	return suffix.replace(/-\d+$/, "").toLowerCase();
}

function labelFor(key: string): string {
	return key
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export function sniffRepackBins(setupDir: string): RepackBins {
	restoreExcludedBins(setupDir);

	const bins: RepackBins = {
		requiredSize: 0,
		requiredCount: 0,
		selective: [],
		optional: [],
	};
	const selective = new Map<string, SelectiveBinGroup>();
	const optional = new Map<string, OptionalBinGroup>();

	for (const name of fs.readdirSync(setupDir)) {
		const fullPath = join(setupDir, name);
		const stat = fs.statSync(fullPath);
		if (!stat.isFile()) continue;

		if (REQUIRED_BIN.test(name)) {
			bins.requiredSize += stat.size;
			bins.requiredCount += 1;
			continue;
		}
		const selectiveMatch = name.match(SELECTIVE_BIN);
		if (selectiveMatch) {
			const key = groupKey(selectiveMatch[1]);
			const group = selective.get(key) ?? { key, size: 0 };
			group.size += stat.size;
			selective.set(key, group);
			continue;
		}
		const optionalMatch = name.match(OPTIONAL_BIN);
		if (optionalMatch) {
			const key = groupKey(optionalMatch[1]);
			const group =
				optional.get(key) ?? { key, label: labelFor(key), files: [], size: 0 };
			group.files.push(fullPath);
			group.size += stat.size;
			optional.set(key, group);
		}
	}

	bins.selective = [...selective.values()];
	bins.optional = [...optional.values()];
	return bins;
}

/**
 * Moves the groups' bins into a sibling folder the installer never scans.
 * Returns a restore function; always call it once the installer has exited.
 */
export function excludeOptionalBins(
	setupDir: string,
	groups: OptionalBinGroup[],
): () => void {
	const excludedDir = join(setupDir, EXCLUDED_DIR);
	const moved: { from: string; to: string }[] = [];
	if (groups.length > 0) {
		fs.mkdirSync(excludedDir, { recursive: true });
	}
	for (const group of groups) {
		for (const file of group.files) {
			const to = join(excludedDir, basename(file));
			fs.renameSync(file, to);
			moved.push({ from: file, to });
		}
	}
	return () => {
		for (const { from, to } of moved) {
			try {
				fs.renameSync(to, from);
			} catch {
				// Leave the part in the excluded folder; the next sniff recovers it.
			}
		}
		try {
			fs.rmdirSync(excludedDir);
		} catch {
			// Not empty or already gone — either is fine.
		}
	};
}

/** Recovers bins a crashed earlier run left in the excluded folder. */
function restoreExcludedBins(setupDir: string): void {
	const excludedDir = join(setupDir, EXCLUDED_DIR);
	if (!fs.existsSync(excludedDir)) return;
	for (const name of fs.readdirSync(excludedDir)) {
		try {
			fs.renameSync(join(excludedDir, name), join(setupDir, name));
		} catch {
			// Keep going; a stuck file only means that bin stays excluded.
		}
	}
	try {
		fs.rmdirSync(excludedDir);
	} catch {
		// Not empty — some bin could not be moved back.
	}
}
