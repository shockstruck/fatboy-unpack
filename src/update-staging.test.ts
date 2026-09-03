import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
	compatibleUpdateStart,
	stageUpdatePackage,
} from "./update-staging";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(join(os.tmpdir(), "fatboy-update-staging-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("update staging", () => {
	test("classifies a game file tree as an overlay instead of an installer", async () => {
		const packageDir = join(root, "package");
		const gameDir = join(packageDir, "Pal", "Binaries", "Win64");
		fs.mkdirSync(gameDir, { recursive: true });
		fs.writeFileSync(join(gameDir, "Palworld-Win64-Shipping.exe"), "game");

		const staged = await stageUpdatePackage(
			packageDir,
			join(root, "staging"),
			0,
		);

		expect(staged.kind).toBe("overlay");
	});

	test("keeps setup executables and companion bins as installer packages", async () => {
		const packageDir = join(root, "package");
		fs.mkdirSync(packageDir);
		fs.writeFileSync(join(packageDir, "Game Update Setup.exe"), "installer");
		fs.writeFileSync(join(packageDir, "elamigos-1.bin"), "payload");

		const staged = await stageUpdatePackage(
			packageDir,
			join(root, "staging"),
			0,
		);

		expect(staged.kind).toBe("installer");
		if (staged.kind === "installer") {
			expect(staged.installerExe.endsWith("Game Update Setup.exe")).toBe(true);
			expect(
				staged.companionFiles.some((file) => file.endsWith("elamigos-1.bin")),
			).toBe(true);
		}
	});

	test("treats a directly selected exe as an installer regardless of its name", async () => {
		const packageDir = join(root, "package");
		fs.mkdirSync(packageDir);
		const updater = join(packageDir, "build-88943.exe");
		fs.writeFileSync(updater, "installer");
		fs.writeFileSync(join(packageDir, "build-88943.bin"), "payload");

		const staged = await stageUpdatePackage(updater, join(root, "staging"), 0);

		expect(staged.kind).toBe("installer");
		if (staged.kind === "installer") {
			expect(staged.installerExe.endsWith("build-88943.exe")).toBe(true);
			expect(staged.companionFiles).toHaveLength(1);
		}
	});

	test("recognizes a cumulative RUNE updater and resets alternative steps", async () => {
		const packageDir = join(root, "rune-package");
		fs.mkdirSync(join(packageDir, "Update"), { recursive: true });
		fs.mkdirSync(join(packageDir, "RUNE", "Game_Data"), { recursive: true });
		fs.writeFileSync(join(packageDir, "Update", "Setup.exe"), "installer");
		fs.writeFileSync(join(packageDir, "Update", "Setup-1.cdx"), "payload");
		fs.writeFileSync(
			join(packageDir, "RUNE", "Game_Data", "steam_api64.dll"),
			"crack",
		);
		fs.writeFileSync(
			join(packageDir, "release.nfo"),
			"You need the following releases for this:\nGame.Base-RUNE\n\n",
		);

		const rune = await stageUpdatePackage(packageDir, join(root, "staging"), 1);
		expect(rune.kind).toBe("installer");
		if (rune.kind !== "installer") return;
		expect(rune.installerFamily).toBe("rune");
		expect(rune.sceneRequirements).toEqual(["Game.Base-RUNE"]);
		expect(rune.baseReleaseFamily).toBe("RUNE");

		const earlierPackage = join(root, "earlier-package");
		fs.mkdirSync(earlierPackage);
		fs.writeFileSync(join(earlierPackage, "Game Update Setup.exe"), "installer");
		const earlier = await stageUpdatePackage(
			earlierPackage,
			join(root, "staging"),
			0,
		);
		expect(compatibleUpdateStart([earlier, rune], "RUNE")).toBe(1);
	});
});
