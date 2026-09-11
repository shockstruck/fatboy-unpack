import { withBrowserWindow } from "./browser-queue";
import {
	type FileCryptResponse,
	isFileCryptContainerPage,
	parseFileCryptContainer,
} from "./filecrypt";
import { connectRealBrowser } from "./real-browser";

type BrowserPage = Awaited<
	ReturnType<
		Awaited<ReturnType<typeof connectRealBrowser>>["browser"]["pages"]
	>
>[number];
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name: string | null | undefined): string | null {
	if (!name) return null;
	const stripped = name.replace(/[/\\]+/g, "_").trim();
	return stripped.length > 0 ? stripped : null;
}

async function fileCryptRequestHeaders(
	page: BrowserPage,
	containerUrl: string,
): Promise<Record<string, string>> {
	const cookies = await page.cookies(containerUrl).catch(() => []);
	const headers: Record<string, string> = {
		Referer: containerUrl,
		"User-Agent": await page
			.evaluate(() => navigator.userAgent)
			.catch(
				() =>
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
			),
	};
	if (cookies.length > 0) {
		headers.Cookie = cookies
			.map((cookie) => `${cookie.name}=${cookie.value}`)
			.join("; ");
	}
	return headers;
}

export function catchDownload(
	url: string,
	selector: string,
): Promise<string | null> {
	return withBrowserWindow(() => catchDownloadNow(url, selector));
}

async function catchDownloadNow(
	url: string,
	selector: string,
): Promise<string | null> {
	const ffLog = (msg: string) => console.log(`[FuckingFast] ${msg}`);

	let browser: Awaited<ReturnType<typeof connectRealBrowser>>["browser"] | undefined;
	try {
		ffLog(`launching browser for ${url}`);
		const connection = await connectRealBrowser();
		browser = connection.browser;
		const page = connection.page;

		ffLog(`navigating to ${url}`);
		const response = await page.goto(url, { waitUntil: "domcontentloaded" });
		ffLog(
			`goto finished: status=${response?.status() ?? "none"} finalUrl=${page.url()}`,
		);

		await page.waitForSelector("body");
		ffLog(`page ready: title="${await page.title()}"`);

		const button = await page.$(selector);
		if (!button) {
			const buttons = await page.$$eval("button, a", (els) =>
				els.slice(0, 20).map((el) => ({
					tag: el.tagName,
					class: el.className,
					text: (el.textContent ?? "").trim().slice(0, 80),
				})),
			);
			ffLog(`button not found for selector "${selector}"`);
			ffLog(`first buttons/links on page: ${JSON.stringify(buttons)}`);
			return null;
		}

		const downloadPath = await button.evaluate((element) =>
			element.getAttribute("hx-post"),
		);
		if (!downloadPath) {
			ffLog(`button does not have an hx-post endpoint`);
			return null;
		}

		ffLog(`requesting direct url from ${downloadPath}`);
		await page.waitForFunction(
			"Boolean(window.turnstileToken || document.querySelector('[name=cf-turnstile-response]')?.value)",
			{ timeout: 30000 },
		);
		const downloadResponse = await page.evaluate(
			async (path): Promise<{ status: number; downloadURL: string | null }> => {
				const turnstileWindow = window as Window & {
					turnstileToken?: string;
				};
				const turnstileInput = document.querySelector<HTMLInputElement>(
					'[name="cf-turnstile-response"]',
				);
				const token = turnstileWindow.turnstileToken ?? turnstileInput?.value;
				const response = await fetch(path, {
					method: "POST",
					headers: {
						"HX-Request": "true",
						"HX-Target": "",
						"HX-Current-URL": location.href,
					},
					body: new URLSearchParams({
						"cf-turnstile-response": token ?? "",
					}),
				});
				return {
					status: response.status,
					downloadURL: response.headers.get("HX-Redirect"),
				};
			},
			downloadPath,
		);

		const downloadURL = downloadResponse.downloadURL;
		if (!downloadURL) {
			ffLog(
				`download response did not include hx-redirect: status=${downloadResponse.status}`,
			);
			return null;
		}

		ffLog(`captured download url: ${downloadURL}`);
		return downloadURL;
	} catch (err) {
		ffLog(`catchDownload error: ${err}`);
		return null;
	} finally {
		if (browser) {
			await browser.close().catch(() => {});
			ffLog("browser closed");
		}
	}
}

export function renderFileCryptContainer(url: string): Promise<FileCryptResponse> {
	return withBrowserWindow(() => renderFileCryptContainerNow(url));
}

async function renderFileCryptContainerNow(
	url: string,
): Promise<FileCryptResponse> {
	let browser: Awaited<ReturnType<typeof connectRealBrowser>>["browser"] | undefined;
	try {
		const connection = await connectRealBrowser();
		browser = connection.browser;
		await connection.page.evaluateOnNewDocument(() => {
			// FileCrypt's fallback ad script hijacks every click by opening a copy of
			// the container and replacing the working tab with a /Link/ redirect.
			Object.defineProperty(window, "open", {
				value: () => null,
				configurable: false,
				writable: false,
			});
		});

		let recovering = false;
		const onNavigated = (frame: { parentFrame(): unknown; url(): string }) => {
			if (frame.parentFrame() !== null || recovering) return;
			if (isFileCryptContainerPage(frame.url(), url)) return;
			recovering = true;
			void connection.page
				.goto(url, { waitUntil: "domcontentloaded" })
				.catch(() => {})
				.finally(() => {
					recovering = false;
				});
		};
		connection.page.on("framenavigated", onNavigated);

		await connection.page.goto(url, { waitUntil: "domcontentloaded" });
		await connection.page.waitForSelector("body");

		const deadline = Date.now() + 5 * 60_000;
		while (Date.now() < deadline) {
			for (const page of await browser.pages()) {
				if (page !== connection.page) {
					await page.close().catch(() => {});
				}
			}

			if (isFileCryptContainerPage(connection.page.url(), url)) {
				const body = await connection.page.content();
				const ids = parseFileCryptContainer(body);
				if (ids.dlcId || ids.linkIds.length > 0) {
					connection.page.off("framenavigated", onNavigated);
					return {
						body,
						url: connection.page.url(),
						requestHeaders: await fileCryptRequestHeaders(
							connection.page,
							url,
						),
					};
				}
			}

			await connection.page.bringToFront().catch(() => {});
			await sleep(250);
		}

		connection.page.off("framenavigated", onNavigated);
		throw new Error("Timed out waiting for FileCrypt verification");
	} finally {
		await browser?.close().catch(() => {});
	}
}
