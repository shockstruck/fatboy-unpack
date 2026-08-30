// Untracked e2e harness: runs catchUserDownloads against a local mock hoster
// that reproduces real hoster behavior — ad tab + popup opened on click, a
// mid-session hijack, and downloads begun from both a popup and the main tab.
// The real FileCrypt captcha backend is network-blocked here, so this covers
// the catcher itself. Usage: DISPLAY=:99 bun run e2e-mock.ts
import { catchUserDownloads } from "./src/download-catcher";

const PORT = 18989;
const HOSTER = `http://app.localtest.me:${PORT}`;
const SCAM = `http://127.0.0.1:${PORT}`;

const rarBytes = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, ...Array(64).fill(0)]);

const page = (title: string, body: string) =>
	new Response(`<!doctype html><title>${title}</title><body style="font:20px sans-serif;padding:40px">${body}</body>`, {
		headers: { "content-type": "text/html" },
	});

Bun.serve({
	port: PORT,
	hostname: "::",
	fetch(req) {
		const url = new URL(req.url);
		switch (url.pathname) {
			case "/host/1":
				// Real-world pattern: the download button opens an ad tab AND the
				// actual download popup in the same click gesture.
				return page("Hoster page 1", `
					<h1>game.part1.rar</h1>
					<button id="dl" style="font-size:28px;padding:20px" onclick="window.open('${SCAM}/scam');window.open('/popup/1')">Free Download</button>`);
			case "/popup/1":
				return page("Download popup", `
					<h1>Your download is ready</h1>
					<button id="dlnow" style="font-size:28px;padding:20px" onclick="location.href='/dl/game.part1.rar'">DOWNLOAD NOW</button>`);
			case "/host/2":
				// Hijack pattern: the tab redirects itself off-site shortly after
				// load; recovery must snap back so the user can click Download.
				return page("Hoster page 2", `
					<h1>game.part2.rar</h1>
					<button id="dl" style="font-size:28px;padding:20px" onclick="location.href='/dl/game.part2.rar'">Download</button>
					<script>setTimeout(() => { location.href = '${SCAM}/scam'; }, 1500);</script>`);
			case "/scam":
				return page("TOTALLY REAL PRIZE", `<h1>You won! Click here!!</h1>`);
			case "/dl/game.part1.rar":
			case "/dl/game.part2.rar": {
				const name = url.pathname.split("/").at(-1)!;
				return new Response(rarBytes, {
					headers: {
						"content-type": "application/x-rar-compressed",
						"content-disposition": `attachment; filename="${name}"`,
						"x-mock-hoster": "1",
					},
				});
			}
			default:
				return new Response("not found", { status: 404 });
		}
	},
});
console.log(`[e2e] mock hoster on ${HOSTER}`);

const links = [
	{ name: "game.part1.rar", url: `${HOSTER}/host/1` },
	{ name: "game.part2.rar", url: `${HOSTER}/host/2` },
];

const results = await catchUserDownloads(links, {
	onStatus: (message) => console.log(`[e2e status] ${message}`),
	onCaught: (name, index, total) => console.log(`[e2e caught] ${name} (${index}/${total})`),
	timeoutMsPerLink: 120_000,
});

console.log(`[e2e] RESULTS ${JSON.stringify(results, null, 2)}`);
const ok =
	results.length === 2 &&
	results[0]!.downloadURL.endsWith("/dl/game.part1.rar") &&
	results[1]!.downloadURL.endsWith("/dl/game.part2.rar");
console.log(ok ? "[e2e] PASS" : "[e2e] FAIL");
process.exit(ok ? 0 : 1);
