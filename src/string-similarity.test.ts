import { describe, expect, test } from "bun:test";
import { SearchTool } from "ogi-addon";
import {
	findBestGameMatch,
	type Game,
	type MatchOptions,
} from "./string-similarity";

const games: Game[] = [
	{
		name: "Hades - v1.35966 (v1.0) + Bonus Soundtrack",
		url: "hades",
	},
	{
		name: "Hades II - v1.137792 + Bonus OST",
		url: "hades-2",
	},
	{
		name: "Aragami 2: Digital Deluxe Edition - v1.0.30079.0",
		url: "aragami-2",
	},
	{
		name: "Age of Empires 3: Complete Collection",
		url: "age-of-empires-3",
	},
	{
		name: "Age of Empires II: Definitive Edition - v101.103.38051.0",
		url: "age-of-empires-2",
	},
	{
		name: "Final Fantasy IV: The After Years",
		url: "final-fantasy-4",
	},
	{
		name: "FINAL FANTASY VII (2026 Re-release) - Steam Build 21140793",
		url: "final-fantasy-7",
	},
	{
		name: "Final Fantasy VIII Remastered",
		url: "final-fantasy-8",
	},
	{
		name: "FINAL FANTASY VII REBIRTH: Digital Deluxe Edition + All DLCs",
		url: "final-fantasy-7-rebirth",
	},
	{
		name: "Grand Theft Auto V / GTA 5 (Legacy) - v1.0.3725.0",
		url: "grand-theft-auto-5",
	},
	{
		name: "GTA 4 / Grand Theft Auto IV: The Complete Edition - v1.2.0.43",
		url: "grand-theft-auto-4",
	},
	{
		name: "A Plague Tale: Innocence + Coats of Arms DLC",
		url: "plague-tale-innocence",
	},
	{
		name: "A Plague Tale: Requiem - v1.0.0.0 + Protector Pack DLC",
		url: "plague-tale-requiem",
	},
	{
		name: "Mafia 2: Digital Deluxe Edition v.1.0.0.1",
		url: "mafia-2",
	},
];

function match(searchTerm: string, options?: MatchOptions): Game | null {
	return findBestGameMatch(
		searchTerm,
		games,
		new SearchTool(games, ["name"]),
		options,
	);
}

describe("findBestGameMatch", () => {
	test("keeps the original and sequel distinct", () => {
		expect(match("Hades")?.url).toBe("hades");
		expect(match("Hades II")?.url).toBe("hades-2");
	});

	test("treats Roman and Arabic sequel numbers as equivalent", () => {
		expect(match("Hades 2")?.url).toBe("hades-2");
		expect(match("Age of Empires 2: Definitive Edition")?.url).toBe(
			"age-of-empires-2",
		);
		expect(match("Final Fantasy 7")?.url).toBe("final-fantasy-7");
	});

	test("rejects conflicting sequel numbers", () => {
		expect(match("Age of Empires 2")?.name).not.toContain("Empires 3");
		expect(match("Final Fantasy 7")?.name).not.toContain("Fantasy IV");
	});

	test("prefers a base title over a related sequel subtitle", () => {
		expect(match("Final Fantasy VII")?.url).toBe("final-fantasy-7");
	});

	test("allows a base title to match an edition-qualified catalog entry", () => {
		expect(match("Mafia II")?.url).toBe("mafia-2");
	});

	test("uses slash-separated alternate titles", () => {
		expect(match("GTA IV")?.url).toBe("grand-theft-auto-4");
		expect(match("Grand Theft Auto 4")?.url).toBe("grand-theft-auto-4");
	});

	test("preserves meaningful subtitles", () => {
		expect(match("A Plague Tale: Requiem")?.url).toBe("plague-tale-requiem");
	});

	test("returns null for a weak franchise-only resemblance", () => {
		expect(match("Hades Kart Racing")).toBeNull();
	});

	test("filters unsupported catalog variants", () => {
		const variants: Game[] = [
			{
				name: "Example II - v1.0 + 4 Switch Emulators",
				url: "example-2-switch",
			},
			{
				name: "Example II - v1.0",
				url: "example-2-pc",
			},
		];
		const search = new SearchTool(variants, ["name"]);

		expect(findBestGameMatch("Example 2", variants, search)?.url).toBe(
			"example-2-pc",
		);
	});

	test("honors the Hypervisor exclusion option", () => {
		const variants: Game[] = [
			{
				name: "Example III - HYPERVISOR Crack",
				url: "example-3-hv",
			},
			{
				name: "Example III - v1.0",
				url: "example-3",
			},
		];
		const search = new SearchTool(variants, ["name"]);

		expect(
			findBestGameMatch("Example 3", variants, search, {
				ignoreHypervisor: true,
			})?.url,
		).toBe("example-3");
	});
});
