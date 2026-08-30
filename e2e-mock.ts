// Untracked e2e harness: runs catchUserDownloads against a local mock hoster
// that reproduces real hoster behavior — ad tab + popup opened on click, a
// mid-session hijack, and downloads begun from both a popup and the main tab.
// The real FileCrypt captcha backend is network-blocked here, so this covers
// the catcher itself. Usage: DISPLAY=:99 FATBOY_E2E_AUTO=1 bun run e2e-mock.ts
import { catchUserDownloads } from "./src/download-catcher";
import { renderFileCryptContainer } from "./src/download";
import { unlockFileCryptContainer } from "./src/filecrypt";

const PORT = 18989;
const HOSTER = `http://datanodes.localtest.me:${PORT}`;
const FILECRYPT = `http://filecrypt.localtest.me:${PORT}/Container/update.html`;
const SCAM = `http://127.0.0.1:${PORT}`;
const auto = process.env.FATBOY_E2E_AUTO === "1";

const rarBytes = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, ...Array(64).fill(0)]);

const page = (title: string, body: string) =>
	new Response(`<!doctype html><title>${title}</title><body style="font:20px sans-serif;padding:40px">${body}</body>`, {
		headers: { "content-type": "text/html" },
	});

const autoClick = (id: string, delay = 500): string =>
	auto ? `<script>setTimeout(() => document.querySelector('#${id}')?.click(), ${delay})</script>` : "";

Bun.serve({
	port: PORT,
	hostname: "::",
	fetch(req) {
		const url = new URL(req.url);
		switch (url.pathname) {
			case "/Container/update.html":
				return new Response(
					`<!doctype html><title>FileCrypt</title><body>
						<h1>Verified container</h1>
						<script>
							setTimeout(() => {
								const link = document.createElement('a');
								link.setAttribute('onclick', 'openLink("verified-link")');
								link.textContent = 'Continue';
								document.body.append(link);
							}, 500);
						</script>
					</body>`,
					{
						headers: {
							"content-type": "text/html",
							"set-cookie": "PHPSESSID=verified-browser; Path=/",
						},
					},
				);
			case "/host/1": {
				// Real-world pattern: the download button opens an ad tab AND the
				// actual download popup in the same click gesture. Also sets a
				// session cookie the way session-locked hosters do; the PASS check
				// below asserts the catcher captured it.
				const response = page("Hoster page 1", `
					<h1>game.part1.rar</h1>
					<button id="dl" style="font-size:28px;padding:20px" onclick="const download=window.open('about:blank');setTimeout(()=>download.location='/popup/1',1500);window.open('${SCAM}/scam')">Free Download</button>
					${autoClick("dl")}`);
				response.headers.set("set-cookie", "hoster_session=mock-session-token; Path=/");
				return response;
			}
			case "/popup/1":
				return page("Download popup", `
					<h1>Your download is ready</h1>
					<button id="dlnow" style="font-size:28px;padding:20px" onclick="location.href='/dl/game.part1.rar'">DOWNLOAD NOW</button>
					${autoClick("dlnow")}`);
			case "/host/2":
				// Hijack pattern: the tab redirects itself off-site shortly after
				// load; recovery must snap back so the user can click Download.
				return page("Hoster page 2", `
					<h1>game.part2.rar</h1>
					<button id="dl" style="font-size:28px;padding:20px" onclick="location.href='/dl/game.part2.rar'">Download</button>
					<script>
						if (!sessionStorage.getItem('hijacked')) {
							sessionStorage.setItem('hijacked', '1');
							setTimeout(() => { location.href = '${SCAM}/scam'; }, 500);
						}
					</script>
					${autoClick("dl", 1000)}`);
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

const unlocked = await unlockFileCryptContainer(FILECRYPT, {
	request: async (url, init) => {
		if (url === FILECRYPT) {
			return { body: `<div class="pow-captcha"></div>`, url };
		}
		const cookie = new Headers(init?.headers).get("cookie") ?? "";
		if (!cookie.includes("PHPSESSID=verified-browser")) {
			throw new Error("FileCrypt verification cookie was not forwarded");
		}
		return { body: "", url: `${HOSTER}/host/1` };
	},
	renderContainer: renderFileCryptContainer,
});

const links = [
	{ name: "game.part1.rar", url: unlocked[0]?.url ?? "" },
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
	results[1]!.downloadURL.endsWith("/dl/game.part2.rar") &&
	// The session cookie set by /host/1 must ride along for OGI's re-request.
	(results[0]!.headers.Cookie ?? "").includes("hoster_session=mock-session-token");
console.log(ok ? "[e2e] PASS" : "[e2e] FAIL");
process.exit(ok ? 0 : 1);
