import { describe, expect, test } from "bun:test";
import {
	defaultInstallDirectory,
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
