import { basename } from "node:path";
import type { DirectDownloadLink } from "./fitgirl-metadata";

export type DirectDownloadFile = {
	name: string;
	downloadURL: string;
};

export type DownloadPageResolver = (
	url: string,
	selector: string,
) => Promise<string | null>;

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
	}
	return files;
}
