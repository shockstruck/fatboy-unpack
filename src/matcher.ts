export type DownloadLink = { url: string };

export type DownloadService = {
	name: string;
	priority: number;
};

export type RankedDownloadLink = {
	service: DownloadService;
	url: string;
};

function isFilecryptUrl(url: string): boolean {
	try {
		return /filecrypt\./i.test(new URL(url).hostname);
	} catch {
		return /filecrypt\./i.test(url);
	}
}

function matchService(url: URL): DownloadService {
	const hostname = url.hostname.toLowerCase();
	const href = url.toString();

	if (isFilecryptUrl(href)) return { name: "FileCrypt", priority: 5 };
	if (hostname.includes("fuckingfast"))
		return { name: "FuckingFast", priority: 11 };
	if (hostname.includes("gofile")) return { name: "Gofile", priority: 10 };
	if (hostname.includes("1fichier")) return { name: "Fichier", priority: 7 };
	if (hostname.includes("pixeldrain"))
		return { name: "PixelDrain", priority: 6 };
	if (hostname.includes("megadb")) return { name: "MegaDB", priority: 4 };
	if (hostname.includes("bzzhr")) return { name: "BZZHR", priority: 1 };
	if (hostname.includes("datanodes")) return { name: "DataNodes", priority: 0 };
	return { name: "Unknown", priority: 2 };
}

export function resolveServiceFromUrl(url: string): DownloadService {
	return matchService(new URL(url));
}

export function rankDownloadLinks(links: DownloadLink[]): RankedDownloadLink[] {
	const ranked: RankedDownloadLink[] = [];

	for (const link of links) {
		try {
			const service = resolveServiceFromUrl(link.url);
			if (service.priority > 0) {
				ranked.push({ service, url: link.url });
			}
		} catch {
			// Ignore invalid URLs.
		}
	}

	ranked.sort((a, b) => {
		const aIsPreferred =
			a.service.name === "FuckingFast" || a.service.name === "Gofile";
		const bIsPreferred =
			b.service.name === "FuckingFast" || b.service.name === "Gofile";
		if (aIsPreferred !== bIsPreferred) return aIsPreferred ? -1 : 1;
		return b.service.priority - a.service.priority;
	});

	return ranked;
}
