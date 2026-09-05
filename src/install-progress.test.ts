import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { trackInstallProgress } from "./install-progress";

describe("install progress", () => {
	test("measures growth over what the install root already held", async () => {
		const root = fs.mkdtempSync(join(os.tmpdir(), "fatboy-install-progress-"));
		try {
			// The downloaded repack already sits inside the install root.
			fs.writeFileSync(join(root, "fg-01.bin"), Buffer.alloc(800));
			const updates: number[] = [];
			const stop = trackInstallProgress(
				root,
				1_000,
				(update) => updates.push(update.progress),
				10,
			);
			expect(updates).toEqual([0]);

			fs.writeFileSync(join(root, "game.exe"), Buffer.alloc(500));
			await new Promise((resolve) => setTimeout(resolve, 60));
			stop();
			expect(updates.at(-1)).toBe(50);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
