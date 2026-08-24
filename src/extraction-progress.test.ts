import { describe, expect, test } from "bun:test";
import {
	extractAllWithProgress,
	extractWithProgress,
	parseSevenZipProgress,
	parseUnrarProgress,
} from "./extraction-progress";

describe("extraction progress", () => {
	test("parses only 7-Zip progress lines", () => {
		expect(
			parseSevenZipProgress("file-80%.bin\r 12% 1 - file-80%.bin\r 57% 2"),
		).toEqual([12, 57]);
	});

	test("parses only UnRAR percentage indicators", () => {
		expect(
			parseUnrarProgress("Extracting file-80%.bin  12%\b\b\b 57%\r\n"),
		).toEqual([12, 57]);
	});

	test("reports completion only after a successful exit", async () => {
		const progress: number[] = [];

		await extractWithProgress({
			command: process.execPath,
			args: ["-e", 'process.stdout.write("\\r 35% item\\r 100% item")'],
			onProgress: (value) => progress.push(value),
			parseProgress: parseSevenZipProgress,
		});

		expect(progress).toEqual([35, 99, 100]);
	});

	test("includes stdout and stderr when extraction fails", async () => {
		const extraction = extractWithProgress({
			command: process.execPath,
			args: [
				"-e",
				'process.stdout.write("stdout-detail"); process.stderr.write("stderr-detail"); process.exit(7)',
			],
			onProgress: () => {},
			parseProgress: parseSevenZipProgress,
		});

		await expect(extraction).rejects.toThrow("code 7");
		await expect(extraction).rejects.toThrow("stdout-detail");
		await expect(extraction).rejects.toThrow("stderr-detail");
	});

	test("aggregates multiple archives by size", async () => {
		const progress: number[] = [];

		await extractAllWithProgress(
			[
				{
					command: process.execPath,
					args: ["-e", 'process.stdout.write("\\r 50% item\\r 100% item")'],
					size: 1,
					parseProgress: parseSevenZipProgress,
				},
				{
					command: process.execPath,
					args: ["-e", 'process.stdout.write("\\r 50% item\\r 100% item")'],
					size: 3,
					parseProgress: parseSevenZipProgress,
				},
			],
			(value) => progress.push(value),
		);

		expect(progress).toEqual([0, 12.5, 24.75, 25, 62.5, 99.25, 100]);
		expect(progress.filter((value) => value === 100)).toHaveLength(1);
	});
});
