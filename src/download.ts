import { withBrowserWindow } from "./browser-queue";
import {
	type FileCryptResponse,
	isExternalFileCryptDestination,
} from "./filecrypt";
import { connectRealBrowser } from "./real-browser";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		await connection.page.goto(url, { waitUntil: "domcontentloaded" });
		await connection.page.waitForSelector("body");

		// FileCrypt's protected single-link flow opens a duplicate/ad tab and
		// navigates the original tab directly to the hoster. Keep the original
		// focused, close every extra tab, and preserve that final URL instead of
		// waiting three minutes for container controls that will never appear.
		const deadline = Date.now() + 180_000;
		let externalUrl: string | null = null;
		let externalSince = 0;
		while (Date.now() < deadline) {
			for (const page of await browser.pages()) {
				if (page !== connection.page) await page.close().catch(() => {});
			}

			const currentUrl = connection.page.url();
			if (isExternalFileCryptDestination(currentUrl, url)) {
				if (currentUrl !== externalUrl) {
					externalUrl = currentUrl;
					externalSince = Date.now();
				} else if (Date.now() - externalSince >= 1000) {
					return {
						body: await connection.page.content().catch(() => ""),
						url: currentUrl,
					};
				}
			} else {
				externalUrl = null;
				const unlocked = await connection.page
					.$('.dlcdownload, [onclick^="openLink"]')
					.catch(() => null);
				if (unlocked) {
					return {
						body: await connection.page.content(),
						url: currentUrl,
					};
				}
			}

			await connection.page.bringToFront().catch(() => {});
			await sleep(250);
		}

		return {
			body: await connection.page.content().catch(() => ""),
			url: connection.page.url(),
		};
	} finally {
		await browser?.close().catch(() => {});
	}
}
