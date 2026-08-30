import puppeteer from "puppeteer";
import { connect } from "puppeteer-real-browser";

export type RealBrowserConnection = Awaited<ReturnType<typeof connect>>;

// Shared connect() for every visible browser this addon opens.
// puppeteer-real-browser attaches a "targetcreated" listener that awaits
// target.page() and re-runs its page setup on every new tab with zero error
// handling — a popup that closes mid-setup (scam tabs do, and our popup
// policy closes them too) rejects unhandled and kills the whole process
// (TargetCloseError in Page.addScriptToEvaluateOnNewDocument). The main
// tab's setup runs directly inside connect(), so that listener is only a
// liability: detach it. New tabs lose the library's turnstile auto-solver,
// which is fine — popups are either closed or clicked through by the user.
export async function connectRealBrowser(): Promise<RealBrowserConnection> {
	const connection = await connect({
		headless: false,
		turnstile: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
		customConfig: { chromePath: puppeteer.executablePath() },
		connectOption: { defaultViewport: null },
		// On Linux the library spins up its own Xvfb and points Chrome at that
		// invisible virtual display whenever the xvfb package is available —
		// the user could never see or click the window. Our windows are
		// user-facing by definition, so always render on the real DISPLAY.
		disableXvfb: true,
	});
	connection.browser.removeAllListeners("targetcreated");
	return connection;
}
