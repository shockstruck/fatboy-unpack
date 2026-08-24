import { spawn } from "node:child_process";

type ExtractionProcess = {
	command: string;
	args: string[];
	cwd?: string;
};

type ExtractionOptions = ExtractionProcess & {
	onProgress: (progress: number) => void;
	parseProgress: (output: string) => number[];
};

export type ExtractionJob = ExtractionProcess & {
	size: number;
	parseProgress: (output: string) => number[];
};

const MAX_ERROR_OUTPUT_LENGTH = 8_192;

function collectProgress(output: string, pattern: RegExp): number[] {
	return Array.from(output.matchAll(pattern), (match) => Number(match[1]));
}

export function parseSevenZipProgress(output: string): number[] {
	return collectProgress(output, /(?:^|[\r\n])\s*(\d{1,3})%\s/g);
}

export function parseUnrarProgress(output: string): number[] {
	return collectProgress(output, /\b(\d{1,3})%(?=[\b\r\n])/g);
}

export async function extractAllWithProgress(
	jobs: ExtractionJob[],
	onProgress: (progress: number) => void,
): Promise<void> {
	const totalSize = Math.max(
		jobs.reduce((total, job) => total + job.size, 0),
		1,
	);
	let completedSize = 0;
	let lastProgress = -1;
	const reportProgress = (progress: number): void => {
		if (progress <= lastProgress) return;
		lastProgress = progress;
		onProgress(progress);
	};

	reportProgress(0);
	for (const job of jobs) {
		await extractWithProgress({
			...job,
			onProgress: (archiveProgress) =>
				reportProgress(
					((completedSize + job.size * (archiveProgress / 100)) / totalSize) *
						100,
				),
		});
		completedSize += job.size;
	}
}

export function extractWithProgress({
	command,
	args,
	cwd,
	onProgress,
	parseProgress,
}: ExtractionOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let progressOutputTail = "";
		let diagnosticOutput = "";
		let lastProgress = -1;

		const readProgress = (data: Buffer): void => {
			const output = progressOutputTail + data.toString();
			for (const value of parseProgress(output)) {
				// Extraction is only complete once the process exits successfully.
				const progress = Math.min(value, 99);
				if (progress > lastProgress) {
					lastProgress = progress;
					onProgress(progress);
				}
			}
			progressOutputTail = output.slice(-64);
		};

		const retainDiagnostics = (data: Buffer): void => {
			diagnosticOutput = (diagnosticOutput + data.toString()).slice(
				-MAX_ERROR_OUTPUT_LENGTH,
			);
		};

		child.stdout.on("data", (data: Buffer) => {
			readProgress(data);
			retainDiagnostics(data);
		});
		child.stderr.on("data", retainDiagnostics);
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) {
				const detail = diagnosticOutput.trim();
				reject(
					new Error(
						`Extraction failed with code ${code}${detail ? `: ${detail}` : ""}`,
					),
				);
				return;
			}

			if (lastProgress < 100) onProgress(100);
			resolve();
		});
	});
}
