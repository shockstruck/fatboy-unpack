import { describe, expect, test } from "bun:test";
import {
	parseUpdaterLog,
	runeUpdaterStepFraction,
	updaterStepFraction,
	type UpdaterActivity,
} from "./update-progress";

const runEntry = (filename: string): string =>
	`-- Run entry --\n   Run as: Current user\n   Type: Exec\n   Filename: ${filename}\n`;

describe("updater progress", () => {
	test("reads phase transitions out of the Inno log", () => {
		expect(parseUpdaterLog("").phase).toBe("starting");

		const installing = "-- File entry --\nfoo\n-- File entry --\nbar\n";
		expect(parseUpdaterLog(installing)).toEqual({
			phase: "installing",
			filesInstalled: 2,
		});

		const patching = installing + runEntry("Z:\\shadow\\batch.bat");
		expect(parseUpdaterLog(patching).phase).toBe("patching");

		const verifying = patching + runEntry("Z:\\shadow\\RapidCRC.exe");
		expect(parseUpdaterLog(verifying).phase).toBe("verifying");
	});

	test("step fraction is monotone across phases and saturates within bands", () => {
		const points: UpdaterActivity[] = [
			{ phase: "starting", filesInstalled: 0, bytesWritten: 0, elapsedMs: 0 },
			{ phase: "installing", filesInstalled: 5, bytesWritten: 0, elapsedMs: 0 },
			{ phase: "installing", filesInstalled: 50, bytesWritten: 0, elapsedMs: 0 },
			{ phase: "patching", filesInstalled: 50, bytesWritten: 0, elapsedMs: 0 },
			{
				phase: "patching",
				filesInstalled: 50,
				bytesWritten: 4 * 1024 ** 3,
				elapsedMs: 0,
			},
			{
				phase: "patching",
				filesInstalled: 50,
				bytesWritten: 40 * 1024 ** 3,
				elapsedMs: 0,
			},
			{
				phase: "verifying",
				filesInstalled: 50,
				bytesWritten: 40 * 1024 ** 3,
				elapsedMs: 0,
			},
		];
		const fractions = points.map(updaterStepFraction);
		for (let i = 1; i < fractions.length; i++) {
			expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
		}
		expect(fractions.at(-1)!).toBeLessThan(1);
	});

	test("RUNE fraction advances on time or growth and never freezes or reaches 1", () => {
		// A RUNE step whose directory never grows still moves via elapsed time.
		const overTime: UpdaterActivity[] = [
			{ phase: "starting", filesInstalled: 0, bytesWritten: 0, elapsedMs: 0 },
			{ phase: "starting", filesInstalled: 0, bytesWritten: 0, elapsedMs: 30_000 },
			{
				phase: "starting",
				filesInstalled: 0,
				bytesWritten: 0,
				elapsedMs: 5 * 60_000,
			},
		];
		const timeFractions = overTime.map(runeUpdaterStepFraction);
		expect(timeFractions[0]).toBeGreaterThan(0.02);
		for (let i = 1; i < timeFractions.length; i++) {
			expect(timeFractions[i]).toBeGreaterThan(timeFractions[i - 1]);
		}
		expect(timeFractions.at(-1)!).toBeLessThan(1);

		// Directory growth alone also advances it beyond the time-only estimate.
		expect(
			runeUpdaterStepFraction({
				phase: "starting",
				filesInstalled: 0,
				bytesWritten: 8 * 1024 ** 3,
				elapsedMs: 0,
			}),
		).toBeGreaterThan(timeFractions[0]);
	});
});
