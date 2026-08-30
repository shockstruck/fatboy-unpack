import { withBrowserWindow } from "./browser-queue";
import {
	captureDownloadHeaders,
	isAllowedPopup,
} from "./download-catcher";
import {
	type FileCryptResponse,
	isExternalFileCryptDestination,
} from "./filecrypt";
import { resolveServiceFromUrl } from "./matcher";
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

function isKnownDownloadHoster(url: string): boolean {
	try {
		const service = resolveServiceFromUrl(url).name;
		return service !== "Unknown" && service !== "FileCrypt";
	} catch {
		return false;
	}
}

async function captureFileCryptSessionHeaders(
	page: BrowserPage,
	containerUrl: string,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = { Referer: containerUrl };
	const cookies = await page.cookies(containerUrl).catch(() => []);
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
		const browserCdp = await browser.target().createCDPSession();
		type DownloadBeginEvent = {
			url: string;
			guid: string;
			suggestedFilename?: string;
		};
		let caught: DownloadBeginEvent | undefined;
		const onDownload = (event: DownloadBeginEvent) => {
			caught ??= event;
		};
		browserCdp.on("Browser.downloadWillBegin", onDownload);
		try {
			await browserCdp.send("Browser.setDownloadBehavior", {
				behavior: "allow",
				downloadPath: "/tmp",
				eventsEnabled: true,
			});
			await connection.page.goto(url, { waitUntil: "domcontentloaded" });
			await connection.page.waitForSelector("body");

			// Keep this browser alive from FileCrypt verification through the hoster
			// click. The real URL and session headers only exist once Chrome starts
			// the transfer, so returning a hoster URL here would discard both.
			const deadline = Date.now() + 5 * 60_000;
			const popupFirstSeen = new Map<BrowserPage, number>();
			let hosterPage: BrowserPage | null = null;
			let clickedOpenLink = false;
			while (Date.now() < deadline && !caught) {
				const pages = await browser.pages();
				for (const page of pages) {
					const pageUrl = page.url();
					if (isKnownDownloadHoster(pageUrl)) {
						hosterPage = page;
						continue;
					}
					if (page === connection.page) continue;
					if (
						hosterPage &&
						isAllowedPopup(pageUrl, hosterPage.url())
					) {
						continue;
					}
					const firstSeen = popupFirstSeen.get(page) ?? Date.now();
					popupFirstSeen.set(page, firstSeen);
					const isPendingFileCryptPopup =
						pageUrl === "about:blank" ||
						!pageUrl ||
						!isExternalFileCryptDestination(pageUrl, url);
					if (
						!isPendingFileCryptPopup ||
						Date.now() - firstSeen >= 2500
					) {
						await page.close().catch(() => {});
						popupFirstSeen.delete(page);
					}
				}

				if (!hosterPage && isKnownDownloadHoster(connection.page.url())) {
					hosterPage = connection.page;
				}

				if (!hosterPage) {
					const dlcButton = await connection.page
						.$(".dlcdownload")
						.catch(() => null);
					if (dlcButton) {
						return {
							body: await connection.page.content(),
							url: connection.page.url(),
							requestHeaders: await captureFileCryptSessionHeaders(
								connection.page,
								url,
							),
						};
					}

					if (!clickedOpenLink) {
						const openLink = await connection.page
							.$('[onclick^="openLink"]')
							.catch(() => null);
						if (openLink) {
							clickedOpenLink = true;
							await openLink.click().catch(() =>
								openLink.evaluate((element) =>
									(element as HTMLElement).click(),
								),
							);
						}
					}
				}

				await (hosterPage ?? connection.page).bringToFront().catch(() => {});
				await sleep(250);
			}

			if (!caught) {
				throw new Error("Timed out waiting for the FileCrypt download to start");
			}
			if (!hosterPage) {
				hosterPage =
					(await browser.pages()).find((page) =>
						isKnownDownloadHoster(page.url()),
					) ?? null;
			}
			await browserCdp
				.send("Browser.cancelDownload", { guid: caught.guid })
				.catch(() => {});
			const downloadPage = hosterPage ?? connection.page;
			const headers = await captureDownloadHeaders(downloadPage, caught.url);
			headers.Referer = downloadPage.url();
			return {
				body: "",
				url: downloadPage.url(),
				caughtDownload: {
					downloadURL: caught.url,
					suggestedFilename: sanitizeFilename(caught.suggestedFilename),
					headers,
				},
			};
		} finally {
			browserCdp.off("Browser.downloadWillBegin", onDownload);
			await browserCdp.detach().catch(() => {});
		}
	} finally {
		await browser?.close().catch(() => {});
	}
}
