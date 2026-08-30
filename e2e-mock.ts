// Browser e2e harness: keeps one Chrome session from a verified FileCrypt
// page through DataNodes and its download, then exercises the standalone
// catcher against a redirect hijack. Usage:
// DISPLAY=:99 FATBOY_E2E_AUTO=1 bun run e2e-mock.ts
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
						<button class="dlcdownload">DLC</button>
						<table>
							<tr>
								<td><a class="external_link" href="https://fuckingfast.co">fuckingfast.co</a></td>
								<td><a class="button download" href="/Link/slow.html" target="slow">Download</a></td>
							</tr>
							<tr>
								<td><a class="external_link" href="https://datanodes.to">datanodes.to</a></td>
								<td><a class="button download" href="/Link/verified.html" target="verified">Download</a></td>
							</tr>
						</table>
					</body>`,
					{
						headers: {
							"content-type": "text/html",
							"set-cookie": "PHPSESSID=verified-browser; Path=/",
						},
					},
				);
			case "/Link/verified.html":
				return Response.redirect(`${HOSTER}/host/1`, 302);
			case "/Link/slow.html":
				return Response.redirect(`${HOSTER}/host/2`, 302);
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
	request: async (url) => {
		if (url === FILECRYPT) {
			return { body: `<div class="pow-captcha"></div>`, url };
		}
		throw new Error("FileCrypt link resolution left the live browser session");
	},
	renderContainer: renderFileCryptContainer,
});

const first = unlocked[0]?.caughtDownload;
if (!first) throw new Error("FileCrypt browser did not catch the first download");

const remaining = await catchUserDownloads(
	[{ name: "game.part2.rar", url: `${HOSTER}/host/2` }],
	{
		onStatus: (message) => console.log(`[e2e status] ${message}`),
		onCaught: (name, index, total) =>
			console.log(`[e2e caught] ${name} (${index}/${total})`),
		timeoutMsPerLink: 120_000,
	},
);
const results = [first, ...remaining];
const firstHeaders = Object.fromEntries(
	Object.entries(results[0]?.headers ?? {}).map(([name, value]) => [
		name.toLowerCase(),
		value,
	]),
);

console.log(`[e2e] RESULTS ${JSON.stringify(results, null, 2)}`);
const ok =
	results.length === 2 &&
	results[0]!.downloadURL.endsWith("/dl/game.part1.rar") &&
	results[1]!.downloadURL.endsWith("/dl/game.part2.rar") &&
	Boolean(firstHeaders["user-agent"]) &&
	// The session cookie set by /host/1 must ride along for OGI's re-request.
	(firstHeaders.cookie ?? "").includes("hoster_session=mock-session-token");
console.log(ok ? "[e2e] PASS" : "[e2e] FAIL");
process.exit(ok ? 0 : 1);
