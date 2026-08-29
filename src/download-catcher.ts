import puppeteer from "puppeteer";
// puppeteer-real-browser's connect() is typed against
// rebrowser-puppeteer-core, while the adblocker is typed against the
// `puppeteer` alias — same runtime classes (rebrowser 24.8.1), nominally
// different types, hence the one cast in enableAdblock.
import type { HTTPRequest } from "rebrowser-puppeteer-core";
import type { Page as AdblockerPage } from "puppeteer";
import { connect } from "puppeteer-real-browser";
import { PuppeteerExtraPluginAdblocker } from "puppeteer-extra-plugin-adblocker";
import { getDomain } from "tldts-experimental";
import { resolveServiceFromUrl } from "./matcher";

export type CaughtDownload = {
	downloadURL: string;
	suggestedFilename: string | null;
	headers: Record<string, string>;
};

type CatcherLink = { name: string; url: string };

type CatcherBrowser = Awaited<ReturnType<typeof connect>>["browser"];
type CatcherPage = Awaited<ReturnType<CatcherBrowser["newPage"]>>;

// Built once per process and disk-cached by the plugin. The explicit
// interception priority puts the blocker into puppeteer's cooperative
// interception mode so the navigation lockdown below can share the request
// pipeline with it (two legacy-mode handlers would fight over each request).
const adblocker = new PuppeteerExtraPluginAdblocker({
	blockTrackers: true,
	blockTrackersAndAnnoyances: true,
	useCache: true,
	interceptResolutionPriority: 0,
});

type AdblockEngine = Awaited<ReturnType<typeof adblocker.getBlocker>>;

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

// The actual file often lives on a CDN domain unrelated to the hoster, and
// its request is a main-frame navigation too — it must pass the lockdown or
// the download can never begin.
const ARCHIVE_URL_PATTERN = /\.(rar|zip|7z|bin|iso|exe|\d{3})$/i;

// Main-frame navigations may only stay on the hoster itself: the same
// registrable domain, a known mirror of the same service (so datanodes.to ->
// datanodes.io is fine), or a URL that is plainly the file being downloaded.
// Anything else is an ad or redirect hijack and gets aborted before it can
// take over the tab.
export function isAllowedNavigation(
	targetUrl: string,
	hosterUrl: string,
): boolean {
	let target: URL;
	try {
		target = new URL(targetUrl);
	} catch {
		return false;
	}
	// about:blank and friends; top-frame data:/javascript: navigations are
	// refused by Chrome itself.
	if (target.protocol !== "http:" && target.protocol !== "https:") return true;
	if (ARCHIVE_URL_PATTERN.test(target.pathname)) return true;
	try {
		const hosterHostname = new URL(hosterUrl).hostname;
		const targetDomain = getDomain(target.hostname);
		if (targetDomain !== null && targetDomain === getDomain(hosterHostname)) {
			return true;
		}
		const targetService = resolveServiceFromUrl(targetUrl);
		return (
			targetService.name !== "Unknown" &&
			targetService.name === resolveServiceFromUrl(hosterUrl).name
		);
	} catch {
		return false;
	}
}

// puppeteer-extra only applies plugins on "targetcreated", and the working
// tab already exists when puppeteer-real-browser connects — so passing the
// plugin to connect() never adblocks the tab the user actually browses in.
// Enable it explicitly instead. If the filter engine couldn't be built,
// still turn interception on (the navigation lockdown in catchOneDownload
// needs it) with a cooperative continue-all handler so requests never stall
// while no lockdown is armed — the lockdown's abort outranks it.
async function enableAdblock(
	page: CatcherPage,
	engine: AdblockEngine | null,
): Promise<void> {
	if (engine) {
		await engine
			.enableBlockingInPage(page as unknown as AdblockerPage)
			.catch(() => {});
	} else {
		await page.setRequestInterception(true).catch(() => {});
		page.on("request", (request) => {
			if (request.isInterceptResolutionHandled()) return;
			void request.continue(request.continueRequestOverrides(), 0);
		});
	}
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

	// Cooperative-mode lockdown: abort any main-frame navigation that leaves
	// the hoster (see isAllowedNavigation). Server-side redirect chains that
	// started on an allowed URL stay allowed — download tokens commonly 302
	// out to an unrelated CDN. Subframes are untouched so captcha widgets
	// keep working; ad subresources are the adblocker's job.
	const blocked = { count: 0 };
	const lockdown = (request: HTTPRequest): void => {
		if (request.isInterceptResolutionHandled()) return;
		const frame = request.frame();
		const isMainFrameNavigation =
			request.isNavigationRequest() &&
			frame !== null &&
			frame.parentFrame() === null;
		if (isMainFrameNavigation && !isAllowedNavigation(request.url(), link.url)) {
			const chainStart = request.redirectChain()[0];
			const cameFromAllowedUrl =
				chainStart !== undefined &&
				isAllowedNavigation(chainStart.url(), link.url);
			if (!cameFromAllowedUrl) {
				blocked.count += 1;
				void request.abort("blockedbyclient", 0);
				return;
			}
		}
		void request.continue(request.continueRequestOverrides(), 0);
	};
	page.on("request", lockdown);

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
			const blockedNote =
				blocked.count > 0
					? ` (blocked ${blocked.count} off-site redirects)`
					: "";
			reject(
				new Error(
					`Timed out waiting for a download from "${link.name}"${blockedNote}`,
				),
			);
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
		page.off("request", lockdown);
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

	// First run fetches filter lists from the network (a few seconds);
	// afterwards the serialized engine is loaded from disk cache.
	options.onStatus("Loading adblock filter lists...");
	const engine = await adblocker.getBlocker().catch(() => null);
	if (!engine) {
		options.onStatus(
			"Adblock filter lists unavailable; continuing with redirect protection only.",
		);
	}

	let browser: CatcherBrowser | undefined;
	try {
		options.onStatus("Opening a browser window for manual downloads...");
		const connection = await connect({
			headless: false,
			turnstile: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
			customConfig: { chromePath: puppeteer.executablePath() },
			connectOption: { defaultViewport: null },
		});
		browser = connection.browser;
		let page: CatcherPage = connection.page;
		await enableAdblock(page, engine);

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
					await enableAdblock(fresh, engine);
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
