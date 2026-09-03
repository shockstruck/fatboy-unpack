import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { applyLocalUpdatePackages } from "./update-flow";
import { backupDirFor } from "./update-transaction";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(join(os.tmpdir(), "fatboy-update-flow-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("local update flow", () => {
	test("applies a loose-file archive over the recorded installation root", async () => {
		const downloadDir = join(root, "Deck SD", "OGI", "Palworld");
		const installDir = join(downloadDir, "Palworld [FitGirl Repack]");
		const executable = join(
			installDir,
			"Pal",
			"Binaries",
			"Win64",
			"Palworld-Win64-Shipping.exe",
		);
		fs.mkdirSync(join(installDir, "Pal", "Binaries", "Win64"), {
			recursive: true,
		});
		fs.writeFileSync(executable, "old build");

		const packageDir = join(downloadDir, "Palworld update");
		const updatedExecutable = join(
			packageDir,
			"Pal",
			"Binaries",
			"Win64",
			"Palworld-Win64-Shipping.exe",
		);
		fs.mkdirSync(join(packageDir, "Pal", "Binaries", "Win64"), {
			recursive: true,
		});
		fs.writeFileSync(updatedExecutable, "new build");
		fs.writeFileSync(join(packageDir, "update-marker.bin"), "payload");

		const logs: string[] = [];
		const result = await applyLocalUpdatePackages({
			packages: [packageDir],
			downloadArtifacts: [packageDir],
			installDir,
			targetVersion: "v0.6.9",
			currentLibraryInfo: {
				appID: 1623730,
				cwd: join(installDir, "Pal", "Binaries", "Win64"),
				launchExecutable: "Palworld-Win64-Shipping.exe",
			},
			context: {
				platform: "linux",
				umuRunPath: "/not-needed-for-overlay",
				homeDir: root,
			},
			log: (message) => logs.push(message),
		});

		expect(fs.readFileSync(executable, "utf-8")).toBe("new build");
		expect(
			fs.readFileSync(join(installDir, "update-marker.bin"), "utf-8"),
		).toBe("payload");
		expect(
			fs.readFileSync(
				join(
					backupDirFor(installDir),
					"Pal",
					"Binaries",
					"Win64",
					"Palworld-Win64-Shipping.exe",
				),
				"utf-8",
			),
		).toBe("old build");
		expect(logs.some((line) => line.includes("Copying update files"))).toBe(
			true,
		);
		expect(fs.existsSync(packageDir)).toBe(false);
		expect(result.appliedPackages).toEqual([packageDir]);
	});

	test("keeps downloaded packages when the update transaction fails", async () => {
		const installDir = join(root, "Game");
		fs.mkdirSync(installDir);
		fs.writeFileSync(join(installDir, "data.bin"), "old build");

		const packageDir = join(root, "failed update");
		fs.mkdirSync(packageDir);
		fs.writeFileSync(join(packageDir, "data.bin"), "new build");

		await expect(
			applyLocalUpdatePackages({
				packages: [packageDir],
				downloadArtifacts: [packageDir],
				installDir,
				targetVersion: "v2",
				currentLibraryInfo: {
					appID: 1,
					cwd: installDir,
					launchExecutable: "missing.exe",
				},
				context: {
					platform: "linux",
					umuRunPath: "/not-needed-for-overlay",
					homeDir: root,
				},
				log: () => {},
			}),
		).rejects.toThrow("game executable missing.exe is missing");

		expect(fs.existsSync(packageDir)).toBe(true);
		expect(fs.readFileSync(join(installDir, "data.bin"), "utf-8")).toBe(
			"old build",
		);
	});
});
