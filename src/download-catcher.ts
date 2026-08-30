// puppeteer-real-browser's connect() is typed against
// rebrowser-puppeteer-core, while the adblocker is typed against the
// `puppeteer` alias — same runtime classes (rebrowser 24.8.1), nominally
// different types, hence the one cast in enableAdblock.
import type { Target } from "rebrowser-puppeteer-core";
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
// interception priority keeps the blocker in puppeteer's cooperative
// interception mode so any other handler can share the request pipeline.
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

// The actual file often lives on a CDN domain unrelated to the hoster;
// treat plainly-a-download URLs as allowed everywhere.
const ARCHIVE_URL_PATTERN = /\.(rar|zip|7z|bin|iso|exe|\d{3})$/i;

// The main frame may only stay on the hoster itself: the same registrable
// domain, a known mirror of the same service (so datanodes.to ->
// datanodes.io is fine), or a URL that is plainly the file being downloaded.
// Anything else is an ad or redirect hijack.
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
// Enable it explicitly instead. Without a filter engine the page just runs
// unblocked — hijack recovery below still handles redirect takeovers.
async function enableAdblock(
	page: CatcherPage,
	engine: AdblockEngine | null,
): Promise<void> {
	if (!engine) return;
	await engine
		.enableBlockingInPage(page as unknown as AdblockerPage)
		.catch(() => {});
}

// Close every page except the working tab and popups that are allowed or
// still being classified, then refocus the working tab. Protecting pending
// popups matters: one rejected ad must not sweep away a legitimate popup
// while it is still sitting on about:blank.
async function closePopupPages(
	browser: CatcherBrowser,
	mainPage: CatcherPage,
	allowedPopups: Set<unknown>,
	pendingTargets: Set<unknown>,
): Promise<void> {
	try {
		const pages = await browser.pages();
		for (const page of pages) {
			if (
				page !== mainPage &&
				!allowedPopups.has(page) &&
				!pendingTargets.has(page.target())
			) {
				await page.close().catch(() => {});
			}
		}
		if (allowedPopups.size === 0 && pendingTargets.size === 0) {
			await mainPage.bringToFront();
		}
	} catch {
		// Browser or page may already be closing.
	}
}

// Scam popups open on about:blank and only then navigate; give a new tab a
// brief grace period to reveal its real URL before judging it. Kept short —
// every millisecond here is a scam tab on screen, and the browser-wide
// download catcher (below) doesn't depend on this tab surviving.
async function resolvePopupUrl(popup: CatcherPage): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const url = popup.url();
		if (url && url !== "about:blank") return url;
		await sleep(100);
	}
	return popup.url();
}

export async function captureDownloadHeaders(
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
		for (let waited = 0; waited < 2000 && !Object.keys(headers).length; waited += 100) {
			await sleep(100);
		}
		// Session-locked hosters bind the download URL to browser cookies, so a
		// cookie-less re-request from outside the browser would 403. Forward
		// exactly what the browser would send to this URL.
		try {
			const { cookies } = await client.send("Network.getCookies", {
				urls: [downloadURL],
			});
			if (cookies.length > 0) {
				headers.Cookie = cookies
					.map((cookie) => `${cookie.name}=${cookie.value}`)
					.join("; ");
			}
		} catch {
			// Cookie capture is best-effort; the URL and Referer still stand.
		}
		client.off("Network.responseReceived", onResponse);
		await client.detach().catch(() => {});
		return headers;
	} catch {
		return {};
	}
}

// Hijack recovery instead of request blocking: a download never *commits* a
// navigation (Chrome turns it into a transfer), so anything that actually
// lands the main frame on a disallowed URL can only be an ad hijack — snap
// the tab back to the hoster. Request-time aborts (the previous approach)
// couldn't tell a hijack from a download URL on an unrelated CDN and killed
// legitimate downloads.
function installHijackRecovery(
	page: CatcherPage,
	hosterUrl: string,
	blocked: { count: number },
): () => void {
	const onNavigated = (frame: { parentFrame(): unknown; url(): string }) => {
		if (frame.parentFrame() !== null) return;
		const url = frame.url();
		if (isAllowedNavigation(url, hosterUrl)) return;
		blocked.count += 1;
		void page.goto(hosterUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
	};
	page.on("framenavigated", onNavigated);
	return () => page.off("framenavigated", onNavigated);
}

type DownloadBeginEvent = {
	url: string;
	guid: string;
	suggestedFilename?: string;
};

// One CDP session on the browser target catches downloads from EVERY tab —
// main tab, allowed popups, even a popup that starts its download before we
// finish judging it. Per-tab sessions had a fatal race: a download begun in
// a fresh popup before its own session was armed was silently lost.
async function armBrowserDownloadCatcher(
	browser: CatcherBrowser,
): Promise<CatcherCDPSession> {
	const cdp = await browser.target().createCDPSession();
	await cdp.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: "/tmp",
		eventsEnabled: true,
	});
	return cdp;
}

async function catchOneDownload(
	browser: CatcherBrowser,
	browserCdp: CatcherCDPSession,
	page: CatcherPage,
	link: CatcherLink,
	timeoutMs: number,
	engine: AdblockEngine | null,
): Promise<CaughtDownload> {
	const blocked = { count: 0 };
	const removeHijackRecovery = installHijackRecovery(page, link.url, blocked);

	// The browser-wide session is already armed; just listen. Registered
	// before navigating so a download that fires instantly on load is caught.
	let settled = false;
	let onDownload!: (event: DownloadBeginEvent) => void;
	const downloadPromise = new Promise<DownloadBeginEvent>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const blockedNote =
				blocked.count > 0
					? ` (recovered from ${blocked.count} off-site hijacks)`
					: "";
			reject(
				new Error(
					`Timed out waiting for a download from "${link.name}"${blockedNote}`,
				),
			);
		}, timeoutMs);
		onDownload = (event) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(event);
		};
	});
	browserCdp.on("Browser.downloadWillBegin", onDownload);

	// New tabs: allow same-hoster and FileCrypt tabs (adblocked like the main
	// tab), close everything else — those are the scam tabs. The user may end
	// up pressing the download button in an allowed popup; the browser-wide
	// CDP session catches its download without any per-popup arming, so even
	// a download that begins mid-judging is not lost.
	const allowedPopups = new Set<CatcherPage>();
	const pendingTargets = new Set<Target>();
	const popupTasks = new Set<Promise<void>>();
	const handlePopup = async (target: Target): Promise<void> => {
		let popup: CatcherPage | null = null;
		try {
			popup = target.type() === "page" ? await target.page() : null;
			if (popup && popup !== page && !allowedPopups.has(popup)) {
				const url = await resolvePopupUrl(popup);
				if (isAllowedPopup(url, link.url)) {
					allowedPopups.add(popup);
					popup.on("close", () => allowedPopups.delete(popup));
					// An allowed popup that later drifts to a scam URL gets closed
					// instead of redirected — it isn't the user's working tab.
					popup.on("framenavigated", (frame) => {
						if (frame.parentFrame() !== null) return;
						if (isAllowedPopup(frame.url(), link.url)) return;
						void popup.close().catch(() => {});
					});
					await enableAdblock(popup, engine);
					return;
				}
				await popup.close().catch(() => {});
			}
		} catch {
			// The tab may already be closed or the browser may be going down.
		} finally {
			pendingTargets.delete(target);
		}
	};
	const popupHandler = (target: Target) => {
		if (target.type() !== "page") return;
		pendingTargets.add(target);
		const task = handlePopup(target);
		popupTasks.add(task);
		void task.finally(() => popupTasks.delete(task));
	};
	browser.on("targetcreated", popupHandler);
	const popupSweep = setInterval(() => {
		void closePopupPages(browser, page, allowedPopups, pendingTargets);
	}, 500);
	try {
		// A navigation that itself triggers the download commonly aborts with
		// net::ERR_ABORTED; that's fine, downloadPromise still catches it.
		await page.goto(link.url, { waitUntil: "domcontentloaded" }).catch(() => {});
		await sleep(1000);
		await closePopupPages(browser, page, allowedPopups, pendingTargets);

		const caught = await downloadPromise;

		try {
			await browserCdp.send("Browser.cancelDownload", { guid: caught.guid });
		} catch {
			// The file still lands in /tmp, but we already have the URL.
		}

		const headers = await captureDownloadHeaders(page, caught.url);
		headers.Referer = link.url;

		return {
			downloadURL: caught.url,
			suggestedFilename: sanitizeFilename(caught.suggestedFilename),
			headers,
		};
	} finally {
		clearInterval(popupSweep);
		browserCdp.off("Browser.downloadWillBegin", onDownload);
		browser.off("targetcreated", popupHandler);
		removeHijackRecovery();
		await Promise.allSettled(popupTasks);
		for (const popup of allowedPopups) {
			await popup.close().catch(() => {});
		}
		await closePopupPages(browser, page, new Set(), new Set());
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
		const browserCdp = await armBrowserDownloadCatcher(browser);
		let page: CatcherPage = connection.page;
		await enableAdblock(page, engine);

		for (const [index, link] of links.entries()) {
			options.onStatus(`Waiting for you to start the download for "${link.name}"...`);
			try {
				const caught = await catchOneDownload(
					browser,
					browserCdp,
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
