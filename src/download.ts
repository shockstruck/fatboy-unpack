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
type BrowserElement = NonNullable<
	Awaited<ReturnType<BrowserPage["$"]>>
>;
type BrowserCDPSession = Awaited<
	ReturnType<BrowserPage["createCDPSession"]>
>;

type NetworkRequestEvent = {
	requestId: string;
	request: {
		url: string;
		method: string;
		headers: Record<string, string | number>;
	};
};

type NetworkRequestExtraInfoEvent = {
	requestId: string;
	headers: Record<string, string | number>;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRequestHeaders(
	headers: Record<string, string | number>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers)
			.filter(([name]) => !name.startsWith(":"))
			.map(([name, value]) => [name.toLowerCase(), String(value)]),
	);
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

async function dismissFileCryptAdOverlay(page: BrowserPage): Promise<boolean> {
	return page.evaluate(() => {
		for (const host of document.querySelectorAll<HTMLElement>("[doskip]")) {
			const closeButton = host.shadowRoot?.querySelector<HTMLElement>("#closeButton");
			if (!closeButton) continue;
			closeButton.click();
			return true;
		}
		return false;
	});
}

async function findFileCryptHosterLink(
	page: BrowserPage,
): Promise<BrowserElement | null> {
	const buttons = await page
		.$$('a.button.download[href*="/Link/"], [onclick^="openLink"]')
		.catch(() => []);
	let fallback: BrowserElement | null = buttons[0] ?? null;

	for (const button of buttons) {
		const advertisedUrl = await button
			.evaluate((element) => {
				const externalLink = (element as Element)
					.closest("tr")
					?.querySelector("a.external_link");
				return externalLink instanceof HTMLAnchorElement
					? externalLink.href
					: null;
			})
			.catch(() => null);
		if (!advertisedUrl) continue;
		try {
			if (resolveServiceFromUrl(advertisedUrl).name === "DataNodes") {
				return button;
			}
			fallback ??= button;
		} catch {
			// Keep the first usable link when the host label is unrecognized.
		}
	}

	return fallback;
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
		const networkSessions = new Map<BrowserPage, BrowserCDPSession>();
		const requestUrls = new Map<string, string>();
		const ignoredRequestIds = new Set<string>();
		const pendingExtraHeaders = new Map<string, Record<string, string>>();
		const requestHeadersByUrl = new Map<string, Record<string, string>>();
		const watchRequests = async (page: BrowserPage): Promise<void> => {
			if (networkSessions.has(page)) return;
			const cdp = await page.createCDPSession();
			const onRequest = (event: NetworkRequestEvent) => {
				requestUrls.set(event.requestId, event.request.url);
				if (event.request.method === "HEAD") {
					ignoredRequestIds.add(event.requestId);
					return;
				}
				const headers = {
					...normalizeRequestHeaders(event.request.headers),
					...pendingExtraHeaders.get(event.requestId),
				};
				pendingExtraHeaders.delete(event.requestId);
				requestHeadersByUrl.set(event.request.url, headers);
			};
			const onExtraInfo = (event: NetworkRequestExtraInfoEvent) => {
				if (ignoredRequestIds.has(event.requestId)) return;
				const extra = normalizeRequestHeaders(event.headers);
				const requestUrl = requestUrls.get(event.requestId);
				if (!requestUrl) {
					pendingExtraHeaders.set(event.requestId, extra);
					return;
				}
				requestHeadersByUrl.set(requestUrl, {
					...requestHeadersByUrl.get(requestUrl),
					...extra,
				});
			};
			cdp.on("Network.requestWillBeSent", onRequest);
			cdp.on("Network.requestWillBeSentExtraInfo", onExtraInfo);
			await cdp.send("Network.enable");
			networkSessions.set(page, cdp);
		};
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
			await watchRequests(connection.page);
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
					await watchRequests(page).catch(() => {});
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
					await dismissFileCryptAdOverlay(connection.page).catch(() => false);
					if (!clickedOpenLink) {
						const openLink = await findFileCryptHosterLink(connection.page);
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
			const requestHeaders = requestHeadersByUrl.get(caught.url);
			const fallbackHeaders = await captureDownloadHeaders(
				downloadPage,
				caught.url,
			);
			const headers = requestHeaders
				? { ...requestHeaders }
				: normalizeRequestHeaders(fallbackHeaders);
			if (!headers.cookie && fallbackHeaders.Cookie) {
				headers.cookie = fallbackHeaders.Cookie;
			}
			headers.referer ??= downloadPage.url();
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
			await Promise.allSettled(
				Array.from(networkSessions.values(), (session) => session.detach()),
			);
			await browserCdp.detach().catch(() => {});
		}
	} finally {
		await browser?.close().catch(() => {});
	}
}
