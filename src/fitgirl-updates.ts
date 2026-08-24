import { join } from "node:path";
import { JSDOM } from "jsdom";
import { extractRepackVersion } from "./repack-store";

export const FITGIRL_UPDATES_URL = "https://fitgirl-repacks.site/updates-list/";

export type FitGirlUpdate = {
	name: string;
	url: string;
};

export type DownloadedUpdateGroup = {
	files: string[];
};

function normalizedTitle(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function parseFitGirlUpdates(
	html: string,
	gameName: string,
): FitGirlUpdate[] {
	const document = new JSDOM(html).window.document;
	const wanted = normalizedTitle(gameName);
	const spoiler = Array.from(
		document.querySelectorAll<HTMLElement>(".su-spoiler"),
	).find((item) => {
		const title = item.querySelector(".su-spoiler-title")?.textContent ?? "";
		return normalizedTitle(title) === wanted;
	});
	if (!spoiler) return [];

	return Array.from(
		spoiler.querySelectorAll<HTMLAnchorElement>(
			'.su-spoiler-content a[href*="filecrypt."]',
		),
	).map((anchor) => ({
		name: anchor.textContent?.trim() || "FitGirl update package",
		url: anchor.href,
	}));
}

export function resolveDownloadedUpdatePackages(
	downloadDir: string,
	groups: DownloadedUpdateGroup[],
): string[] {
	return groups.flatMap((group) => {
		const entryArchive =
			group.files.find((file) => /\.part0*1\.rar$/i.test(file)) ??
			group.files[0];
		return entryArchive ? [join(downloadDir, entryArchive)] : [];
	});
}

export function inferUpdateTargetVersion(
	packageName: string | undefined,
): string {
	if (!packageName) return "unknown";
	const build = packageName.match(/\bbuild(?:id)?[\s._-]*(\d+)/i)?.[1];
	return build ?? extractRepackVersion(packageName);
}
