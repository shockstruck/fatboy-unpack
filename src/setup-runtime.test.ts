import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	defaultInstallDirectory,
	gameDirectoryName,
	repackCleanupDirectories,
	resolveQueuedDownloadDirectory,
	sikarugirFrameworks,
	sikarugirLauncher,
	sikarugirPrefix,
	sikarugirWine,
} from "./setup-runtime";

describe("setup runtime", () => {
	test("uses the game root outside a torrent's hidden setup directory", () => {
		expect(
			defaultInstallDirectory(
				"/Users/test/Games/Terraria/.torrent/Terraria [FitGirl Repack]/",
			),
		).toBe("/Users/test/Games/Terraria");
	});

	test("uses a sibling directory named after the actual game", () => {
		expect(
			defaultInstallDirectory(
				"/Users/test/Games/FuckingFast _ Terraria/",
				"Terraria",
			),
		).toBe("/Users/test/Games/Terraria");
		expect(
			defaultInstallDirectory(
				"/Users/test/Games/1337x _ Terraria/.torrent/Terraria [FitGirl Repack]/",
				"Terraria",
			),
		).toBe("/Users/test/Games/Terraria");
	});

	test("installs above OGI's hash staging directory", () => {
		const hash = "4bd6c7e4c009f5abdb7461db6b78d33aac591867";
		expect(
			defaultInstallDirectory(
				`/mnt/OGI/Dead Cells/${hash}/Dead Cells [FitGirl Repack]`,
				"Dead Cells",
			),
		).toBe("/mnt/OGI/Dead Cells");
		expect(
			defaultInstallDirectory(
				`/mnt/OGI/${hash}/Dead Cells [FitGirl Repack]`,
				"Dead Cells",
			),
		).toBe("/mnt/OGI/Dead Cells");
	});

	test("strips hash staging even when no game name is available", () => {
		const hash = "4bd6c7e4c009f5abdb7461db6b78d33aac591867";
		expect(
			defaultInstallDirectory(`/mnt/OGI/Dead Cells/${hash}/repack`),
		).toBe("/mnt/OGI/Dead Cells");
	});

	test("keeps an existing game-named directory and sanitizes unsafe names", () => {
		expect(defaultInstallDirectory("/Users/test/Games/Terraria/", "Terraria")).toBe(
			"/Users/test/Games/Terraria",
		);
		expect(gameDirectoryName('Game: Deluxe/Edition?')).toBe(
			"Game_ Deluxe_Edition_",
		);
	});

	test("finds queued update downloads rooted above a nested torrent setup", () => {
		const root = "/mnt/OGI";
		const updatesDir = join(root, "fatboy-updates-123");
		const setupDir = join(root, "Game", "torrent-hash", "Game [FitGirl Repack]");
		expect(
			resolveQueuedDownloadDirectory(
				setupDir,
				"fatboy-updates-123",
				(path) => path === updatesDir,
			),
		).toBe(updatesDir);
	});

	test("falls back to the legacy sibling update location", () => {
		expect(
			resolveQueuedDownloadDirectory(
				"/mnt/OGI/Game/repack",
				"fatboy-updates-123",
				() => false,
			),
		).toBe("/mnt/OGI/Game/fatboy-updates-123");
	});

	test("includes OGI's mirrored repack directory under old_files", () => {
		const setupDir = "/mnt/OGI/Game/hash/Game [FitGirl Repack]";
		const mirroredDir = "/mnt/OGI/Game/old_files/hash/Game [FitGirl Repack]";
		expect(
			repackCleanupDirectories(
				setupDir,
				(path) => path === "/mnt/OGI/Game/old_files" || path === mirroredDir,
			),
		).toEqual([setupDir, mirroredDir]);
	});

	test("resolves OGI's shared Sikarugir launcher", () => {
		expect(sikarugirLauncher("/Users/test")).toBe(
			"/Users/test/Applications/Sikarugir/Steam.app/Contents/MacOS/launcher",
		);
		expect(sikarugirWine("/Users/test")).toBe(
			"/Users/test/Applications/Sikarugir/Steam.app/Contents/SharedSupport/wine/bin/wine",
		);
		expect(sikarugirPrefix("/Users/test")).toBe(
			"/Users/test/Applications/Sikarugir/Steam.app/Contents/SharedSupport/prefix",
		);
		expect(sikarugirFrameworks("/Users/test")).toBe(
			"/Users/test/Applications/Sikarugir/Steam.app/Contents/Frameworks",
		);
	});
});
