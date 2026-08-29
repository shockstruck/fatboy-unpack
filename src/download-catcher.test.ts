import { describe, expect, test } from "bun:test";
import { isAllowedNavigation } from "./download-catcher";

const hoster = "https://datanodes.to/abc123/game.part1.rar.html";

describe("isAllowedNavigation", () => {
	test("allows staying on the hoster's domain", () => {
		expect(isAllowedNavigation("https://datanodes.to/download", hoster)).toBe(true);
		expect(isAllowedNavigation("https://cdn.datanodes.to/x", hoster)).toBe(true);
	});

	test("allows mirrors of the same service on another TLD", () => {
		expect(isAllowedNavigation("https://datanodes.io/download", hoster)).toBe(true);
	});

	test("allows the file itself on an unrelated CDN", () => {
		expect(
			isAllowedNavigation("https://fs17.someweirdcdn.net/d/game.part1.rar", hoster),
		).toBe(true);
		expect(
			isAllowedNavigation("https://cdn.example.com/files/setup.001", hoster),
		).toBe(true);
	});

	test("blocks off-site ad and redirect hijacks", () => {
		expect(isAllowedNavigation("https://sketchy-ads.example.com/land", hoster)).toBe(false);
		expect(isAllowedNavigation("https://xxx-popunder.cam/", hoster)).toBe(false);
		expect(isAllowedNavigation("not-a-url", hoster)).toBe(false);
	});

	test("allows non-http schemes like about:blank", () => {
		expect(isAllowedNavigation("about:blank", hoster)).toBe(true);
	});
});
