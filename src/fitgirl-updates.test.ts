import { describe, expect, test } from "bun:test";
import {
	inferUpdateTargetVersion,
	parseFitGirlUpdates,
	resolveDownloadedUpdatePackages,
	trackedFitGirlUpdateVersion,
} from "./fitgirl-updates";

describe("parseFitGirlUpdates", () => {
	test("returns ordered FileCrypt update packages for the matching game", () => {
		const html = `
			<div class="su-spoiler">
				<div class="su-spoiler-title"><span></span>Other Game</div>
				<div class="su-spoiler-content">
					<a href="https://filecrypt.cc/Container/OTHER.html">Other.Update.rar</a>
				</div>
			</div>
			<div class="su-spoiler">
				<div class="su-spoiler-title"><span></span>Slay the Spire 2</div>
				<div class="su-spoiler-content">
					<a href="https://fitgirl-repacks.site/slay-the-spire-2/">Repack page</a>
					<ol>
						<li><a href="https://filecrypt.cc/Container/FIRST.html">Slay.the.Spire.2.Update.Build.100.rar</a></li>
						<li><a href="https://filecrypt.cc/Container/SECOND.html">Slay.the.Spire.2.Update.Build.200.rar</a></li>
					</ol>
				</div>
			</div>
		`;

		expect(parseFitGirlUpdates(html, "Slay the Spire 2")).toEqual([
			{
				name: "Slay.the.Spire.2.Update.Build.100.rar",
				url: "https://filecrypt.cc/Container/FIRST.html",
			},
			{
				name: "Slay.the.Spire.2.Update.Build.200.rar",
				url: "https://filecrypt.cc/Container/SECOND.html",
			},
		]);
	});
});

describe("resolveDownloadedUpdatePackages", () => {
	test("selects one entry archive per update group in package order", () => {
		expect(
			resolveDownloadedUpdatePackages("/downloads", [
				{
					files: ["Update.100.part1.rar", "Update.100.part2.rar"],
				},
				{ files: ["Update.200.rar"] },
			]),
		).toEqual(["/downloads/Update.100.part1.rar", "/downloads/Update.200.rar"]);
	});
});

describe("inferUpdateTargetVersion", () => {
	test("reads dotted scene build numbers in the format OGI displays", () => {
		expect(
			inferUpdateTargetVersion(
				"Slay.the.Spire.2.Update.Build.23811903-RUNE.rar",
			),
		).toBe("23811903");
	});
});

describe("trackedFitGirlUpdateVersion", () => {
	test("only exposes packages after a matching positive update check", () => {
		expect(
			trackedFitGirlUpdateVersion(
				{ checkedVersion: "1.0", availableVersion: "1.1" },
				"1.0",
			),
		).toBe("1.1");
		expect(
			trackedFitGirlUpdateVersion({ checkedVersion: "1.0" }, "1.0"),
		).toBeUndefined();
		expect(
			trackedFitGirlUpdateVersion(
				{ checkedVersion: "1.0", availableVersion: "1.1" },
				"1.1",
			),
		).toBeUndefined();
	});
});
