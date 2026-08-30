import { JSDOM } from "jsdom";

export type FileCryptContainerIds = {
	dlcId?: string;
	linkIds: string[];
};

export type FileCryptLink = {
	name: string;
	url: string;
};

export type FileCryptResponse = {
	body: string;
	url: string;
};

export type FileCryptRequest = (
	url: string,
	init?: RequestInit,
) => Promise<FileCryptResponse>;

export type FileCryptDependencies = {
	request: FileCryptRequest;
	renderContainer?: (url: string) => Promise<string | FileCryptResponse>;
};

export const requestFileCryptResource: FileCryptRequest = async (url, init) => {
	const headers = new Headers(init?.headers);
	if (!headers.has("user-agent")) {
		headers.set(
			"user-agent",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
		);
	}
	const response = await fetch(url, {
		...init,
		redirect: "follow",
		headers,
	});
	if (!response.ok) {
		throw new Error(`FileCrypt request failed (${response.status}): ${url}`);
	}
	return { body: await response.text(), url: response.url || url };
};

function argumentFromOnclick(onclick: string | null): string | undefined {
	return onclick?.match(/\(\s*["']([^"']+)["']\s*\)/)?.[1];
}

export function parseFileCryptContainer(html: string): FileCryptContainerIds {
	const document = new JSDOM(html).window.document;
	const dlcId = argumentFromOnclick(
		document
			.querySelector<HTMLElement>(".dlcdownload")
			?.getAttribute("onclick") ?? null,
	);
	const linkIds = Array.from(
		document.querySelectorAll<HTMLElement>("[onclick]"),
	).flatMap((element) => {
		const onclick = element.getAttribute("onclick");
		if (!onclick || !/^openLink\s*\(/i.test(onclick)) return [];
		const argument = argumentFromOnclick(onclick);
		if (!argument) return [];
		return [element.getAttribute(argument) ?? argument];
	});

	return dlcId ? { dlcId, linkIds } : { linkIds };
}

function parseDecryptedLinks(body: string): string[] {
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || !("success" in parsed)) {
		return [];
	}
	const success = parsed.success;
	if (!success || typeof success !== "object" || !("links" in success)) {
		return [];
	}
	return Array.isArray(success.links)
		? success.links.filter((link): link is string => typeof link === "string")
		: [];
}

function linkName(url: string, index: number): string {
	try {
		const parsed = new URL(url);
		const name =
			parsed.hash.slice(1) || parsed.pathname.split("/").filter(Boolean).at(-1);
		return name ? decodeURIComponent(name) : `part${index}.rar`;
	} catch {
		return `part${index}.rar`;
	}
}

export function isExternalFileCryptDestination(
	url: string,
	containerUrl: string,
): boolean {
	try {
		const rendered = new URL(url);
		const container = new URL(containerUrl);
		return (
			(rendered.protocol === "http:" || rendered.protocol === "https:") &&
			rendered.hostname !== container.hostname &&
			!/filecrypt\./i.test(rendered.hostname)
		);
	} catch {
		return false;
	}
}

export async function unlockFileCryptContainer(
	containerUrl: string,
	dependencies: FileCryptDependencies,
): Promise<FileCryptLink[]> {
	const container = await dependencies.request(containerUrl);
	let ids = parseFileCryptContainer(container.body);
	if (!ids.dlcId && ids.linkIds.length === 0 && dependencies.renderContainer) {
		const rendered = await dependencies.renderContainer(containerUrl);
		const renderedResponse =
			typeof rendered === "string"
				? { body: rendered, url: containerUrl }
				: rendered;
		ids = parseFileCryptContainer(renderedResponse.body);
		// Single-link protected containers navigate the working tab straight to
		// the hoster after verification instead of revealing openLink elements.
		if (
			!ids.dlcId &&
			ids.linkIds.length === 0 &&
			isExternalFileCryptDestination(renderedResponse.url, containerUrl)
		) {
			return [
				{
					name: linkName(renderedResponse.url, 0),
					url: renderedResponse.url,
				},
			];
		}
	}
	const { dlcId, linkIds } = ids;
	if (dlcId) {
		try {
			const dlcUrl = new URL(
				`/DLC/${encodeURIComponent(dlcId)}.dlc`,
				containerUrl,
			);
			const dlc = await dependencies.request(dlcUrl.toString());
			const decrypted = await dependencies.request(
				"http://dcrypt.it/decrypt/paste",
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ content: dlc.body }).toString(),
				},
			);
			const links = parseDecryptedLinks(decrypted.body);
			if (links.length > 0) {
				return links.map((url, index) => ({
					name: linkName(url, index),
					url,
				}));
			}
		} catch {
			// The per-link redirect path below is FileCrypt's built-in fallback.
		}
	}

	const links = await Promise.all(
		linkIds.map(async (id, index): Promise<FileCryptLink> => {
			const linkUrl = new URL(
				`/Link/${encodeURIComponent(id)}.html`,
				containerUrl,
			);
			const response = await dependencies.request(linkUrl.toString());
			return {
				name: linkName(response.url, index),
				url: response.url,
			};
		}),
	);

	return links;
}
