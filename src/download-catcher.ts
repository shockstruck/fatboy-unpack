// puppeteer-real-browser's connect() is typed against
// rebrowser-puppeteer-core, while the adblocker is typed against the
// `puppeteer` alias — same runtime classes (rebrowser 24.8.1), nominally
// different types, hence the one cast in enableAdblock.
import type { HTTPRequest, Target } from "rebrowser-puppeteer-core";
import type { Page as AdblockerPage } from "puppeteer";
import { PuppeteerExtraPluginAdblocker } from "puppeteer-extra-plugin-adblocker";
import { getDomain } from "tldts-experimental";
import { withBrowserWindow } from "./browser-queue";
import { resolveServiceFromUrl } from "./matcher";
import { connectRealBrowser } from "./real-browser";

export type CaughtDownload = {
	downloadURL: string;
	suggestedFilename: string | null;
	headers: Record<string, string>;
};

type CatcherLink = { name: string; url: string };

type CatcherBrowser = Awaited<ReturnType<typeof connectRealBrowser>>["browser"];
type CatcherPage = Awaited<ReturnType<CatcherBrowser["newPage"]>>;
type CatcherCDPSession = Awaited<ReturnType<CatcherPage["createCDPSession"]>>;

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

// New tabs are allowed only when they land on the hoster itself or on
// FileCrypt (filecrypt.cc interstitials redirect into the hoster); every
// other popup is a scam and gets closed. Callers decide *when* a popup's URL
// is settled enough to judge.
export function isAllowedPopup(url: string, hosterUrl: string): boolean {
	try {
		if (resolveServiceFromUrl(url).name === "FileCrypt") return true;
	} catch {
		return false;
	}
	return isAllowedNavigation(url, hosterUrl);
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

// Close every page except the working tab and explicitly allowed popups,
// then refocus the working tab. Used both after judging a new target and as
// a delayed sweep, since popups opened immediately on navigation can beat
// the "targetcreated" listener.
async function closePopupPages(
	browser: CatcherBrowser,
	mainPage: CatcherPage,
	allowedPopups: Set<unknown>,
): Promise<void> {
	try {
		const pages = await browser.pages();
		for (const page of pages) {
			if (page !== mainPage && !allowedPopups.has(page)) {
				await page.close().catch(() => {});
			}
		}
		if (allowedPopups.size === 0) await mainPage.bringToFront();
	} catch {
		// Browser or page may already be closing.
	}
}

// Scam popups open on about:blank and only then navigate; give a new tab a
// short grace period to reveal its real URL before judging it.
async function resolvePopupUrl(popup: CatcherPage): Promise<string> {
	for (let attempt = 0; attempt < 16; attempt++) {
		const url = popup.url();
		if (url && url !== "about:blank") return url;
		await sleep(250);
	}
	return popup.url();
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

// Cooperative-mode lockdown: abort any main-frame navigation the `allow`
// predicate rejects. Server-side redirect chains that started on an allowed
// URL stay allowed — download tokens commonly 302 out to an unrelated CDN.
// Subframes are untouched so captcha widgets keep working; ad subresources
// are the adblocker's job.
function createNavigationLockdown(
	hosterUrl: string,
	allow: (url: string, hosterUrl: string) => boolean,
	blocked: { count: number },
): (request: HTTPRequest) => void {
	return (request) => {
		if (request.isInterceptResolutionHandled()) return;
		const frame = request.frame();
		const isMainFrameNavigation =
			request.isNavigationRequest() &&
			frame !== null &&
			frame.parentFrame() === null;
		if (isMainFrameNavigation && !allow(request.url(), hosterUrl)) {
			const chainStart = request.redirectChain()[0];
			const cameFromAllowedUrl =
				chainStart !== undefined && allow(chainStart.url(), hosterUrl);
			if (!cameFromAllowedUrl) {
				blocked.count += 1;
				void request.abort("blockedbyclient", 0);
				return;
			}
		}
		void request.continue(request.continueRequestOverrides(), 0);
	};
}

type DownloadBeginEvent = {
	url: string;
	guid: string;
	suggestedFilename?: string;
};

// Downloads must be armed per CDP session — an event from a tab whose
// session never enabled download events is silently lost. Returns the
// session so the caller can cancel the caught transfer through it.
async function armDownloadCatcher(
	page: CatcherPage,
	onDownload: (event: DownloadBeginEvent, cdp: CatcherCDPSession) => void,
): Promise<CatcherCDPSession> {
	const cdp = await page.createCDPSession();
	await cdp.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: "/tmp",
		eventsEnabled: true,
	});
	cdp.on("Browser.downloadWillBegin", (event) => onDownload(event, cdp));
	return cdp;
}

async function catchOneDownload(
	browser: CatcherBrowser,
	page: CatcherPage,
	link: CatcherLink,
	timeoutMs: number,
	engine: AdblockEngine | null,
): Promise<CaughtDownload> {
	const blocked = { count: 0 };
	const lockdown = createNavigationLockdown(
		link.url,
		isAllowedNavigation,
		blocked,
	);
	page.on("request", lockdown);

	// Arm the catcher before navigating so a download that fires instantly on
	// load is still caught. Allowed popups are armed too (below) — the user
	// may press the download button there — so resolution is shared.
	let settled = false;
	let onDownload!: (event: DownloadBeginEvent, cdp: CatcherCDPSession) => void;
	const downloadPromise = new Promise<{
		event: DownloadBeginEvent;
		cdp: CatcherCDPSession;
	}>((resolve, reject) => {
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
		onDownload = (event, cdp) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ event, cdp });
		};
	});
	await armDownloadCatcher(page, onDownload);

	// New tabs: allow same-hoster and FileCrypt tabs (adblocked and locked
	// down like the main tab), close everything else — those are the scam
	// tabs. The user may end up pressing the download button in an allowed
	// popup, so it gets the same treatment as the working tab.
	const allowedPopups = new Set<CatcherPage>();
	const popupHandler = async (target: Target) => {
		try {
			const popup = target.type() === "page" ? await target.page() : null;
			if (popup && popup !== page && !allowedPopups.has(popup)) {
				const url = await resolvePopupUrl(popup);
				if (isAllowedPopup(url, link.url)) {
					allowedPopups.add(popup);
					await enableAdblock(popup, engine);
					popup.on("request", lockdown);
					popup.on("close", () => allowedPopups.delete(popup));
					await armDownloadCatcher(popup, onDownload);
					return;
				}
			}
		} catch {
			// Judging failed (tab already closed, browser going down) — sweep.
		}
		await closePopupPages(browser, page, allowedPopups);
	};
	browser.on("targetcreated", popupHandler);
	try {
		// A navigation that itself triggers the download commonly aborts with
		// net::ERR_ABORTED; that's fine, downloadPromise still catches it.
		await page.goto(link.url, { waitUntil: "domcontentloaded" }).catch(() => {});
		await sleep(1000);
		await closePopupPages(browser, page, allowedPopups);

		const { event: caught, cdp } = await downloadPromise;

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
		for (const popup of allowedPopups) {
			await popup.close().catch(() => {});
		}
	}
}

type CatchUserDownloadsOptions = {
	onStatus: (message: string) => void;
	// Fired after each successful catch, before the next page loads —
	// main.ts surfaces this as a toast so the user knows another click
	// is coming.
	onCaught?: (linkName: string, index: number, total: number) => void;
	timeoutMsPerLink?: number;
};

// Opens one interactive, non-headless browser session and walks the user
// through catching a download for each link: the user solves whatever the
// hoster throws at them and presses its download button; we never fight the
// site, just cancel the transfer once we have the real URL. Queued through
// withBrowserWindow so only one interactive window exists at a time.
export async function catchUserDownloads(
	links: CatcherLink[],
	options: CatchUserDownloadsOptions,
): Promise<CaughtDownload[]> {
	// First run fetches filter lists from the network (a few seconds);
	// afterwards the serialized engine is loaded from disk cache.
	options.onStatus("Loading adblock filter lists...");
	const engine = await adblocker.getBlocker().catch(() => null);
	if (!engine) {
		options.onStatus(
			"Adblock filter lists unavailable; continuing with redirect protection only.",
		);
	}

	return withBrowserWindow(() => catchUserDownloadsNow(links, options, engine));
}

async function catchUserDownloadsNow(
	links: CatcherLink[],
	options: CatchUserDownloadsOptions,
	engine: AdblockEngine | null,
): Promise<CaughtDownload[]> {
	const timeoutMs = options.timeoutMsPerLink ?? 5 * 60_000;
	const results: CaughtDownload[] = [];
	const failed: string[] = [];

	let browser: CatcherBrowser | undefined;
	try {
		options.onStatus("Opening a browser window for manual downloads...");
		const connection = await connectRealBrowser();
		browser = connection.browser;
		let page: CatcherPage = connection.page;
		await enableAdblock(page, engine);

		for (const [index, link] of links.entries()) {
			options.onStatus(`Waiting for you to start the download for "${link.name}"...`);
			try {
				const caught = await catchOneDownload(
					browser,
					page,
					link,
					timeoutMs,
					engine,
				);
				results.push(caught);
				options.onStatus(`Caught download for "${link.name}".`);
				options.onCaught?.(link.name, index + 1, links.length);
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
