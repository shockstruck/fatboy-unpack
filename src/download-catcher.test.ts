import { describe, expect, test } from "bun:test";
import { isAllowedNavigation, isAllowedPopup } from "./download-catcher";

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

describe("isAllowedPopup", () => {
	test("allows same-hoster tabs", () => {
		expect(isAllowedPopup("https://datanodes.to/download", hoster)).toBe(true);
	});

	test("allows FileCrypt interstitials that redirect into the hoster", () => {
		expect(isAllowedPopup("https://filecrypt.cc/Link/abc.html", hoster)).toBe(true);
		expect(isAllowedPopup("https://www.filecrypt.co/Container/x.html", hoster)).toBe(true);
	});

	test("closes scam tabs", () => {
		expect(isAllowedPopup("https://totally-real-sweepstakes.win/", hoster)).toBe(false);
		expect(isAllowedPopup("https://xxx-dating.cam/", hoster)).toBe(false);
	});
});
