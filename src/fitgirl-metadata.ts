import { JSDOM } from "jsdom";
import type { Game } from "./string-similarity";

export type DirectDownloadLink = {
	name: string;
	url: string;
};

export type GameInfo = {
	name: string;
	company: string;
	magnetLink: string;
	torrentLinks: string[];
	coverImage: string;
	steamAppId?: string;
	directLinks: { service: string; links: DirectDownloadLink[] }[];
};

function isDownloadOrContainerUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			/filecrypt\./i.test(parsed.hostname) ||
			/\.(rar|zip|7z|iso)$/i.test(parsed.pathname + parsed.hash) ||
			/\.part\d+\.rar$/i.test(parsed.pathname + parsed.hash)
		);
	} catch {
		return false;
	}
}

function directHosterItems(header: Element): Element[] {
	let sibling = header.nextElementSibling;
	while (sibling && sibling.tagName.toLowerCase() !== "h3") {
		const items = Array.from(sibling.querySelectorAll("li"));
		if (items.length > 0) return items;
		sibling = sibling.nextElementSibling;
	}
	return [];
}

export function parseGameMetadataHtml(game: Game, html: string): GameInfo {
	const document = new JSDOM(html).window.document;
	const data: GameInfo = {
		name: game.name,
		company: "",
		coverImage: "",
		magnetLink: "",
		torrentLinks: [],
		directLinks: [],
	};
	const entry = document.querySelector(".entry-content");
	if (!entry) return data;

	const companyMatch = entry.textContent?.match(
		/Company:\s*(.*?)\s*Languages:/,
	);
	if (companyMatch) data.company = companyMatch[1].trim();
	data.coverImage = entry.querySelector("img")?.getAttribute("src") ?? "";

	const torrentHeader = Array.from(entry.querySelectorAll("h3")).find(
		(header) =>
			(header.textContent?.includes("Download Mirrors (Torrent)") ||
				header.textContent?.includes("Download Mirrors")) &&
			!header.textContent?.includes("Direct Links"),
	);
	if (torrentHeader) {
		const links =
			torrentHeader.nextElementSibling?.querySelectorAll(
				'a[href*="magnet:?"]',
			) ?? [];
		links.forEach((link) => {
			const previous = link.parentElement?.querySelector("a[target=_blank]");
			if (previous?.textContent === "1337x") {
				data.magnetLink = link.getAttribute("href") ?? "";
			}
		});
	}

	const directHeader = Array.from(entry.querySelectorAll("h3")).find((header) =>
		header.textContent?.includes("Download Mirrors (Direct Links)"),
	);
	if (!directHeader) return data;

	for (const item of directHosterItems(directHeader)) {
		const serviceAnchor = item.querySelector("a[href]");
		if (!serviceAnchor) continue;
		const service =
			serviceAnchor.textContent?.match(/Filehoster:\s*(.*)/)?.[1].trim() ??
			"Unknown";
		const links = Array.from(
			item.querySelectorAll<HTMLAnchorElement>(".su-spoiler-content a[href]"),
		).flatMap((anchor): DirectDownloadLink[] => {
			const url = anchor.getAttribute("href") ?? "";
			return isDownloadOrContainerUrl(url)
				? [{ name: anchor.textContent?.trim() || url, url }]
				: [];
		});
		data.directLinks.push({ service, links });
	}

	return data;
}
