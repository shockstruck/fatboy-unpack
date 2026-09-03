import { spawn } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

// Stages update packages before anything touches the installation. Every
// package gets its own directory so installer companions and loose-file
// overlays from different update steps cannot collide.

export type StagedInstallerUpdate = {
	kind: "installer";
	installerFamily: "inno" | "rune";
	/** Isolated directory holding this update's extracted files. */
	stagingDir: string;
	/** The outer installer to invoke. Internal batch/patch tools are never run directly. */
	installerExe: string;
	/** Companion payloads that must stay siblings of the installer. */
	companionFiles: string[];
	/** Scene releases declared as prerequisites by an included NFO. */
	sceneRequirements: string[];
	/** Family of a single cumulative base-release prerequisite, if present. */
	baseReleaseFamily?: string;
};

export type StagedOverlayUpdate = {
	kind: "overlay";
	/** Isolated directory whose tree is copied over the shadow installation. */
	stagingDir: string;
	payloadDir: string;
};

export type StagedUpdate = StagedInstallerUpdate | StagedOverlayUpdate;

function runTool(command: string, args: string[]): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (data: Buffer) => (output += data.toString()));
		child.stderr.on("data", (data: Buffer) => (output += data.toString()));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve(output);
			} else {
				reject(
					new Error(
						`${basename(command)} exited with code ${code}: ${output.slice(-2048)}`,
					),
				);
			}
		});
	});
}

function archiveTool(): { command: string; list: string[]; extract: string[] } {
	if (process.platform === "win32") {
		const sevenZip = "C:\\Program Files\\7-Zip\\7z.exe";
		return {
			command: sevenZip,
			list: ["l", "-ba", "-slt"],
			extract: ["x", "-y"],
		};
	}
	return { command: "unrar", list: ["lb"], extract: ["x", "-idq", "-y"] };
}

function assertEntriesPathSafe(entries: string[]): void {
	for (const entry of entries) {
		const normalized = normalize(entry);
		if (isAbsolute(normalized) || normalized.split(/[\\/]/).includes("..")) {
			throw new Error(`Archive entry escapes the staging directory: ${entry}`);
		}
	}
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
	const tool = archiveTool();
	const output = await runTool(tool.command, [...tool.list, archivePath]);
	if (process.platform === "win32") {
		return output
			.split(/\r?\n/)
			.filter((line) => line.startsWith("Path = "))
			.map((line) => line.slice("Path = ".length));
	}
	return output.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function looksLikeInstaller(file: string): boolean {
	const name = basename(file, ".exe");
	return /(?:^|[._ -])(setup|install(?:er)?|update(?:r)?|patch)(?:$|[._ -])/i.test(
		name,
	);
}

function sceneRequirements(files: string[]): string[] {
	for (const file of files) {
		if (!file.toLowerCase().endsWith(".nfo")) continue;
		const lines = fs.readFileSync(file, "latin1").split(/\r?\n/);
		const marker = lines.findIndex((line) =>
			/You need the following releases for this/i.test(line),
		);
		if (marker === -1) continue;

		const requirements: string[] = [];
		for (const line of lines.slice(marker + 1)) {
			const normalized = line.replace(/[^\x20-\x7e]/g, "").trim();
			if (!normalized) {
				if (requirements.length > 0) break;
				continue;
			}
			if (/^[A-Za-z0-9].*-[A-Za-z0-9]+$/.test(normalized)) {
				requirements.push(normalized);
			} else if (requirements.length > 0) {
				break;
			}
		}
		return requirements;
	}
	return [];
}

export function compatibleUpdateStart(
	updates: StagedUpdate[],
	installedFamily: string | undefined,
): number {
	if (!installedFamily) return 0;
	let start = 0;
	for (const [index, update] of updates.entries()) {
		if (
			update.kind === "installer" &&
			update.baseReleaseFamily === installedFamily.toUpperCase()
		) {
			start = index;
		}
	}
	return start;
}

function classifyStagedUpdate(
	stagingDir: string,
	forcedInstaller?: string,
): StagedUpdate {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
	};
	walk(stagingDir);

	const installerCandidates = forcedInstaller
		? files.filter((file) => basename(file) === forcedInstaller)
		: files.filter(
				(file) =>
					file.toLowerCase().endsWith(".exe") && looksLikeInstaller(file),
			);
	if (installerCandidates.length > 1) {
		throw new Error(
			`Expected one installer .exe in the update package, found: ${installerCandidates
				.map((exe) => basename(exe))
				.join(", ")}`,
		);
	}
	if (installerCandidates.length === 0) {
		if (forcedInstaller) {
			throw new Error(`Failed to stage updater executable: ${forcedInstaller}`);
		}
		return { kind: "overlay", stagingDir, payloadDir: stagingDir };
	}
	const requirements = sceneRequirements(files);
	const installerFamily =
		files.some((file) => file.toLowerCase().endsWith(".cdx")) &&
		files.some((file) => /[\\/]rune[\\/]/i.test(file))
			? "rune"
			: "inno";
	const onlyRequirement = requirements.length === 1 ? requirements[0] : undefined;
	const baseReleaseFamily =
		onlyRequirement && !/(?:^|[._ -])update(?:[._ -]|$)/i.test(onlyRequirement)
			? onlyRequirement.match(/-([A-Za-z0-9]+)$/)?.[1]?.toUpperCase()
			: undefined;

	return {
		kind: "installer",
		installerFamily,
		stagingDir,
		installerExe: installerCandidates[0],
		companionFiles: files.filter((file) => file !== installerCandidates[0]),
		sceneRequirements: requirements,
		baseReleaseFamily,
	};
}

/**
 * Stages one update package into its own directory under `stagingRoot`.
 * Accepts a .rar archive (extracted after a path-safety check) or a directory
 * already containing the installer and its companions (copied as-is).
 */
export async function stageUpdatePackage(
	packagePath: string,
	stagingRoot: string,
	updateIndex: number,
): Promise<StagedUpdate> {
	const stagingDir = join(stagingRoot, `update-${updateIndex}`);
	fs.rmSync(stagingDir, { recursive: true, force: true });
	fs.mkdirSync(stagingDir, { recursive: true });

	const stat = fs.statSync(packagePath);
	let forcedInstaller: string | undefined;
	if (stat.isDirectory()) {
		fs.cpSync(packagePath, stagingDir, { recursive: true });
	} else if (/\.(rar|zip|7z)$/i.test(packagePath)) {
		assertEntriesPathSafe(await listArchiveEntries(packagePath));
		const tool = archiveTool();
		// unrar extracts into cwd-relative target given as trailing dir argument;
		// 7z uses -o. Both keep entry paths, which we validated above.
		const args =
			process.platform === "win32"
				? [...tool.extract, `-o${stagingDir}`, packagePath]
				: [...tool.extract, packagePath, `${stagingDir}/`];
		await runTool(tool.command, args);
	} else if (/\.exe$/i.test(packagePath)) {
		// A bare installer may depend on sibling .bin payloads.
		forcedInstaller = basename(packagePath);
		fs.copyFileSync(packagePath, join(stagingDir, forcedInstaller));
		for (const sibling of fs.readdirSync(dirname(packagePath))) {
			if (/\.bin$/i.test(sibling)) {
				fs.copyFileSync(
					join(dirname(packagePath), sibling),
					join(stagingDir, sibling),
				);
			}
		}
	} else {
		throw new Error(`Unsupported update package: ${basename(packagePath)}`);
	}

	return classifyStagedUpdate(stagingDir, forcedInstaller);
}
