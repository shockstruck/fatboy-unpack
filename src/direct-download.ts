import { basename } from "node:path";
import type { DirectDownloadLink } from "./fitgirl-metadata";
import { resolveServiceFromUrl } from "./matcher";

export type DirectDownloadFile = {
	name: string;
	downloadURL: string;
	headers?: Record<string, string>;
};

export type DownloadPageResolver = (
	url: string,
	selector: string,
) => Promise<string | null>;

const KNOWN_ARCHIVE_EXTENSION = /\.(rar|zip|7z|exe)$/i;

// The rank-and-route decision: does this link set have a fully-automated
// FuckingFast path, or does it need the interactive catcher? Pure so it's
// testable without a browser.
export function hasFuckingFastLink(links: { url: string }[]): boolean {
	return links.some((link) => {
		try {
			return resolveServiceFromUrl(link.url).name === "FuckingFast";
		} catch {
			return false;
		}
	});
}

// Same preference order as matcher.ts's rankDownloadLinks (FuckingFast/Gofile
// first, then by priority), but keeps priority<=0 hosters (e.g. DataNodes) at
// the bottom instead of dropping them — the interactive fallback can still
// have the user click through those, unlike the fully-automated path.
export function rankLinksKeepingLowPriority<T extends { url: string }>(links: T[]): T[] {
	const scored = links.flatMap((link) => {
		try {
			return [{ link, service: resolveServiceFromUrl(link.url) }];
		} catch {
			return [];
		}
	});

	scored.sort((a, b) => {
		const aPreferred = a.service.name === "FuckingFast" || a.service.name === "Gofile";
		const bPreferred = b.service.name === "FuckingFast" || b.service.name === "Gofile";
		if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
		return b.service.priority - a.service.priority;
	});

	return scored.map((entry) => entry.link);
}

// Prefer a hoster-suggested filename, then the original link's own name, and
// only fall back to a synthetic name if neither looks like a real archive.
export function sanitizeDownloadedFileName(
	originalName: string,
	suggestedFilename: string | null,
	fallbackName: string,
): string {
	if (suggestedFilename) {
		const sanitized = basename(suggestedFilename).replace(/[^\w.()\-[\] ]+/g, "_");
		if (KNOWN_ARCHIVE_EXTENSION.test(sanitized)) return sanitized;
	}
	const originalSanitized = basename(originalName).replace(/[^\w.()\-[\] ]+/g, "_");
	return KNOWN_ARCHIVE_EXTENSION.test(originalSanitized)
		? originalSanitized
		: fallbackName;
}

export async function resolveFuckingFastFiles(
	links: DirectDownloadLink[],
	resolvePage: DownloadPageResolver,
	onResolved?: (index: number, total: number) => void,
): Promise<DirectDownloadFile[]> {
	const files: DirectDownloadFile[] = [];
	for (const [index, link] of links.entries()) {
		let downloadURL: string | null = null;
		for (let attempt = 0; attempt < 3 && !downloadURL; attempt++) {
			downloadURL = await resolvePage(link.url, ".link-button.gay-button");
		}
		if (!downloadURL) {
			throw new Error(
				`Failed to find download link from FuckingFast for "${link.name}" after 3 attempts`,
			);
		}
		files.push({ name: `part${index}.rar`, downloadURL });
		onResolved?.(index + 1, links.length);
	}
	if (files.length === 0) throw new Error("No links found");
	return files;
}

export async function resolveFuckingFastUpdateFiles(
	links: DirectDownloadLink[],
	resolvePage: DownloadPageResolver,
	onResolved?: (index: number, total: number) => void,
): Promise<DirectDownloadFile[]> {
	const files: DirectDownloadFile[] = [];
	for (const [index, link] of links.entries()) {
		let downloadURL: string | null = null;
		for (let attempt = 0; attempt < 3 && !downloadURL; attempt++) {
			downloadURL = await resolvePage(link.url, ".link-button.gay-button");
		}
		if (!downloadURL) {
			throw new Error(
				`Failed to resolve update file "${link.name}" after 3 attempts`,
			);
		}
		const originalName = basename(link.name).replace(/[^\w.()\-[\] ]+/g, "_");
		files.push({
			name: /\.(rar|zip|7z|exe)$/i.test(originalName)
				? originalName
				: `update-${index}.rar`,
			downloadURL,
		});
		onResolved?.(index + 1, links.length);
	}
	return files;
}
