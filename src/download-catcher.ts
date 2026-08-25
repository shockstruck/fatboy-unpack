import puppeteer from "puppeteer";
import { connect } from "puppeteer-real-browser";
import { PuppeteerExtraPluginAdblocker } from "puppeteer-extra-plugin-adblocker";

export type CaughtDownload = {
	downloadURL: string;
	suggestedFilename: string | null;
	headers: Record<string, string>;
};

type CatcherLink = { name: string; url: string };

type CatcherBrowser = Awaited<ReturnType<typeof connect>>["browser"];
type CatcherPage = Awaited<ReturnType<CatcherBrowser["newPage"]>>;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strip path separators so a hoster-supplied filename can't escape the
// download directory or otherwise be mistaken for a path.
function sanitizeFilename(name: string | null | undefined): string | null {
	if (!name) return null;
	const stripped = name.replace(/[/\\]+/g, "_").trim();
	return stripped.length > 0 ? stripped : null;
}

// Close every page except the working tab and refocus it. Used both as a
// "targetcreated" listener and as a delayed sweep, since popups opened
// immediately on navigation can beat the listener.
async function closePopupPages(
	browser: CatcherBrowser,
	mainPage: CatcherPage,
): Promise<void> {
	try {
		const pages = await browser.pages();
		for (const page of pages) {
			if (page !== mainPage) {
				await page.close().catch(() => {});
			}
		}
		await mainPage.bringToFront();
	} catch {
		// Browser or page may already be closing.
	}
}

async function captureHeaders(
	page: CatcherPage,
	downloadURL: string,
): Promise<Record<string, string>> {
	try {
		const client = await page.createCDPSession();
		let headers: Record<string, string> = {};
		const onResponse = (event: { response: { url: string; headers: Record<string, string> } }) => {
			if (event.response.url === downloadURL) headers = event.response.headers;
		};
		client.on("Network.responseReceived", onResponse);
		await client.send("Network.enable");
		await page
			.evaluate(
				(url) => fetch(url, { method: "HEAD", credentials: "include" }),
				downloadURL,
			)
			.catch(() => {});
		await sleep(2000);
		client.off("Network.responseReceived", onResponse);
		await client.detach().catch(() => {});
		return headers;
	} catch {
		return {};
	}
}

async function catchOneDownload(
	browser: CatcherBrowser,
	page: CatcherPage,
	link: CatcherLink,
	timeoutMs: number,
): Promise<CaughtDownload> {
	const cdp = await page.createCDPSession();
	await cdp.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: "/tmp",
		eventsEnabled: true,
	});

	// Arm the catcher before navigating so a download that fires instantly on
	// load is still caught.
	const downloadPromise = new Promise<{
		url: string;
		guid: string;
		suggestedFilename?: string;
	}>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`Timed out waiting for a download from "${link.name}"`));
		}, timeoutMs);
		cdp.on("Browser.downloadWillBegin", (event) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(event);
		});
	});

	const popupHandler = () => {
		closePopupPages(browser, page);
	};
	browser.on("targetcreated", popupHandler);
	try {
		// A navigation that itself triggers the download commonly aborts with
		// net::ERR_ABORTED; that's fine, downloadPromise still catches it.
		await page.goto(link.url, { waitUntil: "domcontentloaded" }).catch(() => {});
		await sleep(1000);
		await closePopupPages(browser, page);

		const caught = await downloadPromise;

		try {
			await cdp.send("Browser.cancelDownload", { guid: caught.guid });
		} catch {
			// The file still lands in /tmp, but we already have the URL.
		}

		const headers = await captureHeaders(page, caught.url);
		headers.Referer = link.url;

		return {
			downloadURL: caught.url,
			suggestedFilename: sanitizeFilename(caught.suggestedFilename),
			headers,
		};
	} finally {
		browser.off("targetcreated", popupHandler);
	}
}

// Opens one interactive, non-headless browser session and walks the user
// through catching a download for each link: the user solves whatever the
// hoster throws at them and presses its download button; we never fight the
// site, just cancel the transfer once we have the real URL.
export async function catchUserDownloads(
	links: CatcherLink[],
	options: {
		onStatus: (message: string) => void;
		timeoutMsPerLink?: number;
	},
): Promise<CaughtDownload[]> {
	const timeoutMs = options.timeoutMsPerLink ?? 5 * 60_000;
	const results: CaughtDownload[] = [];
	const failed: string[] = [];

	let browser: CatcherBrowser | undefined;
	try {
		options.onStatus("Opening a browser window for manual downloads...");
		const connection = await connect({
			headless: false,
			turnstile: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
			customConfig: { chromePath: puppeteer.executablePath() },
			connectOption: { defaultViewport: null },
			plugins: [
				new PuppeteerExtraPluginAdblocker({
					blockTrackers: true,
					blockTrackersAndAnnoyances: true,
					useCache: true,
				}),
			],
		});
		browser = connection.browser;
		let page: CatcherPage = connection.page;

		for (const link of links) {
			options.onStatus(`Waiting for you to start the download for "${link.name}"...`);
			try {
				const caught = await catchOneDownload(browser, page, link, timeoutMs);
				results.push(caught);
				options.onStatus(`Caught download for "${link.name}".`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				options.onStatus(`Could not catch a download for "${link.name}": ${message}`);
				failed.push(link.name);
				// The tab may be wedged; recover with a fresh one for the next link
				// instead of aborting the whole batch.
				try {
					const fresh = await browser.newPage();
					await page.close().catch(() => {});
					page = fresh;
				} catch {
					// Fall back to the existing page if a fresh one can't be opened.
				}
			}
		}
	} finally {
		await browser?.close().catch(() => {});
	}

	if (failed.length > 0) {
		throw new Error(`Failed to catch downloads for: ${failed.join(", ")}`);
	}

	return results;
}
