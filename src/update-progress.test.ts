import { describe, expect, test } from "bun:test";
import {
	parseUpdaterLog,
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
			{ phase: "starting", filesInstalled: 0, bytesWritten: 0 },
			{ phase: "installing", filesInstalled: 5, bytesWritten: 0 },
			{ phase: "installing", filesInstalled: 50, bytesWritten: 0 },
			{ phase: "patching", filesInstalled: 50, bytesWritten: 0 },
			{ phase: "patching", filesInstalled: 50, bytesWritten: 4 * 1024 ** 3 },
			{ phase: "patching", filesInstalled: 50, bytesWritten: 40 * 1024 ** 3 },
			{ phase: "verifying", filesInstalled: 50, bytesWritten: 40 * 1024 ** 3 },
		];
		const fractions = points.map(updaterStepFraction);
		for (let i = 1; i < fractions.length; i++) {
			expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
		}
		expect(fractions.at(-1)!).toBeLessThan(1);
	});
});
