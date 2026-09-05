import { describe, expect, test } from "bun:test";
import { hasFuckingFastLink } from "./direct-download";

describe("hasFuckingFastLink", () => {
	test("chooses the FuckingFast fast path when a FuckingFast link is present", () => {
		const links = [
			{ url: "https://obscurehost.example.com/file/abc" },
			{ url: "https://fuckingfast.co/file/xyz" },
		];
		expect(hasFuckingFastLink(links)).toBe(true);
	});

	test("chooses the interactive fallback when no FuckingFast link is present", () => {
		const links = [
			{ url: "https://gofile.io/d/abc" },
			{ url: "https://datanodes.to/file/xyz" },
		];
		expect(hasFuckingFastLink(links)).toBe(false);
	});

	test("ignores invalid URLs and still finds a FuckingFast link", () => {
		const links = [{ url: "not-a-url" }, { url: "https://fuckingfast.co/file/xyz" }];
		expect(hasFuckingFastLink(links)).toBe(true);
	});
});
