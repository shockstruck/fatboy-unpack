import fs from "node:fs";
import { join } from "node:path";

// Per-game installed-repack metadata, persisted relative to the addon cwd
// like the other FatBoy caches (fit-scrape-search.json, repack-data-scrapes/).
const STORE_DIR = "./installed-repacks";

export type AppliedUpdate = {
	/** Opaque version label the update chain targeted (e.g. "v1.50"). */
	version: string;
	/** Package files the update was applied from, in application order. */
	packages: string[];
	appliedAt: string;
};

export type InstalledRepack = {
	appID: number;
	storefront: string;
	name: string;
	/** Exact FitGirl repack page chosen at install time. Never fuzzy-match installed games again. */
	fitgirlUrl?: string;
	/** Full release label from the FitGirl catalog at install time. */
	sourceRelease?: string;
	installDir: string;
	/** Opaque repack version, or "unknown" when the source did not state one. */
	installedVersion: string;
	/** Version advertised by the last check-for-updates; setup must resolve exactly this. */
	pendingUpdateVersion?: string;
	/** Last OGI update check, tied to the installed version it evaluated. */
	lastUpdateCheck?: {
		checkedVersion: string;
		availableVersion?: string;
	};
	/** Previous installation retained after a committed update, removed after a successful launch. */
	pendingBackupDir?: string;
	appliedUpdates: AppliedUpdate[];
};

function recordPath(appID: number): string {
	return join(STORE_DIR, `${appID}.json`);
}

export function loadInstalledRepack(
	appID: number,
): InstalledRepack | undefined {
	const path = recordPath(appID);
	if (!fs.existsSync(path)) {
		return undefined;
	}
	try {
		return JSON.parse(fs.readFileSync(path, "utf-8")) as InstalledRepack;
	} catch {
		return undefined;
	}
}

export function saveInstalledRepack(record: InstalledRepack): void {
	fs.mkdirSync(STORE_DIR, { recursive: true });
	fs.writeFileSync(recordPath(record.appID), JSON.stringify(record, null, 2));
}

export function listInstalledRepacks(): InstalledRepack[] {
	if (!fs.existsSync(STORE_DIR)) {
		return [];
	}
	return fs
		.readdirSync(STORE_DIR)
		.filter((file) => file.endsWith(".json"))
		.map((file) => loadInstalledRepack(Number(file.replace(".json", ""))))
		.filter((record): record is InstalledRepack => record !== undefined);
}

/**
 * Extracts the opaque version label from a repack release name.
 * Versions stay opaque strings; returns "unknown" instead of guessing.
 */
export function extractRepackVersion(releaseLabel: string | undefined): string {
	if (!releaseLabel) {
		return "unknown";
	}
	const match =
		releaseLabel.match(/\bv\.?\s?\d[\w.]*(?:\/[\w.]+)*/i) ??
		releaseLabel.match(/\bbuild(?:id)?\s+\d[\w.]*/i);
	return match ? match[0].replace(/\s+/g, " ").trim() : "unknown";
}
