import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { excludeOptionalBins, sniffRepackBins } from "./repack-bins";

let tempDir: string | undefined;

function makeRepackDir(files: Record<string, number>): string {
	tempDir = fs.mkdtempSync(join(os.tmpdir(), "fatboy-bins-"));
	for (const [name, size] of Object.entries(files)) {
		fs.writeFileSync(join(tempDir, name), Buffer.alloc(size));
	}
	return tempDir;
}

afterEach(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("sniffRepackBins", () => {
	test("classifies required, selective, and optional bins", () => {
		const dir = makeRepackDir({
			"setup.exe": 10,
			"fg-01.bin": 100,
			"fg-02.bin": 100,
			"fg-selective-english.bin": 50,
			"fg-selective-english-2.bin": 25,
			"fg-optional-soundtrack.bin": 40,
			"fg-optional-bonus-content.bin": 30,
			"readme.txt": 5,
		});

		const bins = sniffRepackBins(dir);
		expect(bins.requiredCount).toBe(2);
		expect(bins.requiredSize).toBe(200);
		expect(bins.selective).toEqual([{ key: "english", size: 75 }]);
		expect(bins.optional.map((group) => group.key).sort()).toEqual([
			"bonus-content",
			"soundtrack",
		]);
		const bonus = bins.optional.find((group) => group.key === "bonus-content")!;
		expect(bonus.label).toBe("Bonus Content");
		expect(bonus.size).toBe(30);
	});

	test("groups multi-part optional bins together", () => {
		const dir = makeRepackDir({
			"fg-optional-soundtrack.bin": 40,
			"fg-optional-soundtrack-2.bin": 20,
		});

		const bins = sniffRepackBins(dir);
		expect(bins.optional).toHaveLength(1);
		expect(bins.optional[0].files).toHaveLength(2);
		expect(bins.optional[0].size).toBe(60);
	});
});

describe("excludeOptionalBins", () => {
	test("moves bins aside and restores them", () => {
		const dir = makeRepackDir({
			"fg-01.bin": 100,
			"fg-optional-soundtrack.bin": 40,
		});
		const bins = sniffRepackBins(dir);

		const restore = excludeOptionalBins(dir, bins.optional);
		expect(fs.existsSync(join(dir, "fg-optional-soundtrack.bin"))).toBe(false);
		expect(
			fs.existsSync(
				join(dir, "fatboy-excluded-bins", "fg-optional-soundtrack.bin"),
			),
		).toBe(true);

		restore();
		expect(fs.existsSync(join(dir, "fg-optional-soundtrack.bin"))).toBe(true);
		expect(fs.existsSync(join(dir, "fatboy-excluded-bins"))).toBe(false);
	});

	test("a fresh sniff recovers bins stranded by a crash", () => {
		const dir = makeRepackDir({ "fg-optional-soundtrack.bin": 40 });
		excludeOptionalBins(dir, sniffRepackBins(dir).optional);
		// Simulate a crash: restore() never runs, then a new setup starts.
		const bins = sniffRepackBins(dir);
		expect(bins.optional).toHaveLength(1);
		expect(fs.existsSync(join(dir, "fg-optional-soundtrack.bin"))).toBe(true);
	});
});
