import { describe, expect, test } from "bun:test";
import {
	parseFileCryptContainer,
	type FileCryptRequest,
	unlockFileCryptContainer,
} from "./filecrypt";
import { parseGameMetadataHtml } from "./fitgirl-metadata";
import { resolveFuckingFastFiles } from "./direct-download";

describe("parseFileCryptContainer", () => {
	test("finds the DLC id and fallback link ids", () => {
		const html = `
			<button class="dlcdownload" onclick="downloadDLC('container-123')">DLC</button>
			<a onclick="openLink('part-a')">Part 1</a>
			<a onclick="openLink('part-b')">Part 2</a>
		`;

		expect(parseFileCryptContainer(html)).toEqual({
			dlcId: "container-123",
			linkIds: ["part-a", "part-b"],
		});
	});

	test("returns no ids when the container is still behind a captcha", () => {
		const html = `<form id="captcha"><div class="cf-turnstile"></div></form>`;

		expect(parseFileCryptContainer(html)).toEqual({ linkIds: [] });
	});

	test("reads a fallback id stored in the onclick-named attribute", () => {
		const html = `<a onclick="openLink('token')" token="encoded-link-id">Part</a>`;

		expect(parseFileCryptContainer(html)).toEqual({
			linkIds: ["encoded-link-id"],
		});
	});
});

describe("unlockFileCryptContainer", () => {
	test("downloads and decrypts the container DLC", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const request: FileCryptRequest = async (url, init) => {
			calls.push({ url, init });
			if (url === "https://filecrypt.cc/Container/example.html") {
				return {
					body: `<button class="dlcdownload" onclick="DownloadDLC('abc123')">DLC</button>`,
					url,
				};
			}
			if (url === "https://filecrypt.cc/DLC/abc123.dlc") {
				return { body: "encrypted-dlc", url };
			}
			if (url === "http://dcrypt.it/decrypt/paste") {
				return {
					body: JSON.stringify({
						success: {
							links: [
								"https://fuckingfast.co/token#Update.100.part1.rar",
								"https://fuckingfast.co/dl/part-two.rar",
							],
						},
					}),
					url,
				};
			}
			throw new Error(`Unexpected request: ${url}`);
		};

		await expect(
			unlockFileCryptContainer("https://filecrypt.cc/Container/example.html", {
				request,
			}),
		).resolves.toEqual([
			{
				name: "Update.100.part1.rar",
				url: "https://fuckingfast.co/token#Update.100.part1.rar",
			},
			{
				name: "part-two.rar",
				url: "https://fuckingfast.co/dl/part-two.rar",
			},
		]);
		expect(calls[2].init).toEqual({
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "content=encrypted-dlc",
		});
	});

	test("follows openLink pages when the container has no DLC", async () => {
		const request: FileCryptRequest = async (url) => {
			if (url === "https://filecrypt.cc/Container/fallback.html") {
				return {
					body: `
						<a onclick="openLink('first')">Part 1</a>
						<a onclick="openLink('second')">Part 2</a>
					`,
					url,
				};
			}
			if (url.endsWith("/Link/first.html")) {
				return {
					body: "",
					url: "https://fuckingfast.co/dl/first",
				};
			}
			if (url.endsWith("/Link/second.html")) {
				return {
					body: "",
					url: "https://fuckingfast.co/dl/second",
				};
			}
			throw new Error(`Unexpected request: ${url}`);
		};

		await expect(
			unlockFileCryptContainer("https://filecrypt.cc/Container/fallback.html", {
				request,
			}),
		).resolves.toEqual([
			{ name: "first", url: "https://fuckingfast.co/dl/first" },
			{ name: "second", url: "https://fuckingfast.co/dl/second" },
		]);
	});

	test("renders a captcha-blocked container before unlocking it", async () => {
		const request: FileCryptRequest = async (url) => {
			if (url.includes("/Container/")) {
				return { body: `<div class="cf-turnstile"></div>`, url };
			}
			if (url.includes("/DLC/")) return { body: "dlc", url };
			return {
				body: JSON.stringify({
					success: { links: ["https://fuckingfast.co/dl/rendered"] },
				}),
				url,
			};
		};

		await expect(
			unlockFileCryptContainer("https://filecrypt.cc/Container/captcha.html", {
				request,
				renderContainer: async () =>
					`<button class="dlcdownload" onclick="DownloadDLC('rendered-id')">DLC</button>`,
			}),
		).resolves.toEqual([
			{ name: "rendered", url: "https://fuckingfast.co/dl/rendered" },
		]);
	});

	test("keeps a hoster URL reached directly after captcha verification", async () => {
		const request: FileCryptRequest = async (url) => ({
			body: `<div class="pow-captcha"></div>`,
			url,
		});

		await expect(
			unlockFileCryptContainer("https://filecrypt.cc/Container/direct.html", {
				request,
				renderContainer: async () => ({
					body: `<button>Free Download</button>`,
					url: "https://datanodes.to/download/update-part1.rar.html",
				}),
			}),
		).resolves.toEqual([
			{
				name: "update-part1.rar.html",
				url: "https://datanodes.to/download/update-part1.rar.html",
			},
		]);
	});

	test("uses the verified browser session to resolve rendered link ids", async () => {
		let linkRequestHeaders: HeadersInit | undefined;
		const request: FileCryptRequest = async (url, init) => {
			if (url.includes("/Container/")) {
				return { body: `<div class="pow-captcha"></div>`, url };
			}
			linkRequestHeaders = init?.headers;
			return {
				body: "",
				url: "https://datanodes.to/download/update-part1.rar.html",
			};
		};

		await expect(
			unlockFileCryptContainer("https://filecrypt.cc/Container/session.html", {
				request,
				renderContainer: async () => ({
					body: `<a onclick="openLink('verified-link')">Download</a>`,
					url: "https://filecrypt.cc/Container/session.html",
					requestHeaders: {
						Cookie: "PHPSESSID=verified-session",
						Referer: "https://filecrypt.cc/Container/session.html",
					},
				}),
			}),
		).resolves.toEqual([
			{
				name: "update-part1.rar.html",
				url: "https://datanodes.to/download/update-part1.rar.html",
			},
		]);
		expect(linkRequestHeaders).toEqual({
			Cookie: "PHPSESSID=verified-session",
			Referer: "https://filecrypt.cc/Container/session.html",
		});
	});

	test("returns a download caught before the rendered browser closes", async () => {
		const request: FileCryptRequest = async (url) => ({
			body: `<div class="pow-captcha"></div>`,
			url,
		});
		const caughtDownload = {
			downloadURL: "https://cdn.datanodes.to/files/update.rar",
			suggestedFilename: "update.rar",
			headers: {
				Cookie: "datanodes_session=live-browser",
				Referer: "https://datanodes.to/download/update",
			},
		};

		await expect(
			unlockFileCryptContainer("https://filecrypt.cc/Container/live.html", {
				request,
				renderContainer: async () => ({
					body: "",
					url: "https://datanodes.to/download/update",
					caughtDownload,
				}),
			}),
		).resolves.toEqual([
			{
				name: "update.rar",
				url: "https://datanodes.to/download/update",
				caughtDownload,
			},
		]);
	});
});

describe("parseGameMetadataHtml", () => {
	test("keeps FileCrypt container URLs from direct-link spoilers", () => {
		const html = `
			<article class="entry-content">
				<h3>Download Mirrors (Direct Links)</h3>
				<p>Mirrors</p>
				<ul>
					<li>
						<a href="#multi">Filehoster: MultiUpload (10+ hosters)</a>
						<div class="su-spoiler-content">
							<a href="https://filecrypt.cc/Container/abc123.html">Open container</a>
						</div>
					</li>
				</ul>
			</article>
		`;

		const metadata = parseGameMetadataHtml(
			{ name: "Example Game", url: "https://fitgirl.example/example" },
			html,
		);

		expect(metadata.directLinks).toEqual([
			{
				service: "MultiUpload (10+ hosters)",
				links: [
					{
						name: "Open container",
						url: "https://filecrypt.cc/Container/abc123.html",
					},
				],
			},
		]);
	});

	test("keeps archive names carried in a hoster URL fragment", () => {
		const html = `
			<article class="entry-content">
				<h3>Download Mirrors (Direct Links)</h3>
				<ul><li>
					<a href="#fast">Filehoster: FuckingFast</a>
					<div class="su-spoiler-content">
						<a href="https://fuckingfast.co/abc#Game.part01.rar">Part 1</a>
					</div>
				</li></ul>
			</article>
		`;

		const metadata = parseGameMetadataHtml(
			{ name: "Game", url: "https://fitgirl.example/game" },
			html,
		);

		expect(metadata.directLinks[0]?.links).toEqual([
			{
				name: "Part 1",
				url: "https://fuckingfast.co/abc#Game.part01.rar",
			},
		]);
	});
});

describe("resolveFuckingFastFiles", () => {
	test("maps hoster pages to OGI multipart direct files", async () => {
		const resolvedPages: string[] = [];
		const files = await resolveFuckingFastFiles(
			[
				{ name: "original-a", url: "https://fuckingfast.co/a" },
				{ name: "original-b", url: "https://fuckingfast.co/b" },
			],
			async (url) => {
				resolvedPages.push(url);
				return url.endsWith("/a")
					? "https://cdn.example/archive-a"
					: "https://cdn.example/archive-b";
			},
		);

		expect(files).toEqual([
			{ name: "part0.rar", downloadURL: "https://cdn.example/archive-a" },
			{ name: "part1.rar", downloadURL: "https://cdn.example/archive-b" },
		]);
		expect(resolvedPages).toEqual([
			"https://fuckingfast.co/a",
			"https://fuckingfast.co/b",
		]);
	});
});
