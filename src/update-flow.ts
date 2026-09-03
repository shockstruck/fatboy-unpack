import fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { LibraryInfo } from "ogi-addon";
import {
	buildInstallerLaunchPlan,
	convertUmuIdToGameId,
	dismissBlockingCompanions,
	driveRuneInstaller,
	killWinePrefixProcesses,
	runInstaller,
	snapshotGameWindows,
	type UmuContext,
} from "./installer-runner";
import { extractRepackVersion } from "./repack-store";
import {
	describeUpdaterActivity,
	trackUpdaterActivity,
	updaterStepFraction,
} from "./update-progress";
import {
	compatibleUpdateStart,
	stageUpdatePackage,
	type StagedUpdate,
} from "./update-staging";
import { applyUpdateTransaction, type UpdateStep } from "./update-transaction";

// Orchestrates one local-package update: stage everything first, then apply
// the chain through UpdateTransaction with optional rollback protection.
// Callers only supply the package files and the library entry being updated.

export type UpdateExecutionContext = {
	platform: NodeJS.Platform;
	umuRunPath: string;
	homeDir: string;
};

export type UpdateLibraryInfo = Pick<
	LibraryInfo,
	"appID" | "cwd" | "launchExecutable" | "umu"
>;

function buildUmuContext(
	libraryInfo: UpdateLibraryInfo,
	context: UpdateExecutionContext,
): UmuContext {
	const umuId = libraryInfo.umu?.umuId ?? `umu:${libraryInfo.appID}`;
	const gameId = convertUmuIdToGameId(umuId);
	return {
		umuRunPath: context.umuRunPath,
		gameId,
		winePrefix:
			libraryInfo.umu?.winePrefixPath ??
			join(context.homeDir, ".ogi-wine-prefixes", gameId),
		protonPath: libraryInfo.umu?.protonVersion,
	};
}

function readLogTail(logFile: string, lineCount = 20): string | undefined {
	try {
		const lines = fs
			.readFileSync(logFile, "utf-8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0);
		return lines.slice(-lineCount).join("\n") || undefined;
	} catch {
		return undefined;
	}
}

function installedSceneFamily(installDir: string): string | undefined {
	const walk = (dir: string): string | undefined => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				const family = walk(fullPath);
				if (family) return family;
			} else if (entry.isFile() && entry.name.toLowerCase() === "steam_api64.rne") {
				return "RUNE";
			}
		}
		return undefined;
	};
	try {
		return walk(installDir);
	} catch {
		return undefined;
	}
}

/** Resolves the installation directory the update must patch. */
export function installDirOf(libraryInfo: UpdateLibraryInfo): string {
	return libraryInfo.cwd;
}

export async function applyLocalUpdatePackages(options: {
	/** Package files (.rar or updater .exe) in prerequisite order. */
	packages: string[];
	/** Game installation root; defaults to cwd during initial installation. */
	installDir?: string;
	/** Downloaded files OGI placed in the live directory for this update. */
	downloadArtifacts?: string[];
	targetVersion: string;
	currentLibraryInfo: UpdateLibraryInfo;
	context: UpdateExecutionContext;
	log: (message: string) => void;
	setProgress?: (progress: number) => void;
	createBackup?: boolean;
}): Promise<{ backupDir?: string; appliedPackages: string[] }> {
	const {
		packages,
		installDir: suppliedInstallDir,
		downloadArtifacts = [],
		targetVersion,
		currentLibraryInfo,
		context,
		log,
		setProgress,
		createBackup,
	} = options;
	const installDir = suppliedInstallDir ?? installDirOf(currentLibraryInfo);
	if (!fs.existsSync(installDir)) {
		throw new Error(`Installation directory does not exist: ${installDir}`);
	}

	const stagingRoot = join(
		dirname(installDir),
		`.${basename(installDir)}.fatboy-update-staging`,
	);
	fs.rmSync(stagingRoot, { recursive: true, force: true });

	try {
		// Stage the full chain before touching anything so a bad package cannot
		// leave the game partially advanced.
		const stagedPackages: { packagePath: string; staged: StagedUpdate }[] = [];
		for (const [index, packagePath] of packages.entries()) {
			log(
				`Staging update package ${index + 1}/${packages.length}: ${basename(packagePath)}`,
			);
			const staged = await stageUpdatePackage(packagePath, stagingRoot, index);
			stagedPackages.push({ packagePath, staged });
		}
		const chainStart = compatibleUpdateStart(
			stagedPackages.map(({ staged }) => staged),
			installedSceneFamily(installDir),
		);
		if (chainStart > 0) {
			log(
				`Skipping ${chainStart} earlier update package(s); ${basename(
					stagedPackages[chainStart].packagePath,
				)} is a cumulative updater for the installed scene release.`,
			);
		}
		const selectedPackages = stagedPackages.slice(chainStart);

		const steps: UpdateStep[] = [];
		for (const [index, { packagePath, staged }] of selectedPackages.entries()) {
			const label = extractRepackVersion(basename(packagePath));
			const stepLabel = label === "unknown" ? `package ${index + 1}` : label;
			steps.push({
				label: stepLabel,
				run: async (targetDir, onStepProgress) => {
					if (staged.kind === "overlay") {
						log(`Copying update files from ${basename(packagePath)}...`);
						fs.cpSync(staged.payloadDir, targetDir, {
							recursive: true,
							force: true,
						});
						return 0;
					}
					const umu =
						context.platform === "win32"
							? undefined
							: buildUmuContext(currentLibraryInfo, context);
					const logFile = join(staged.stagingDir, "installer.log");
					const plan = buildInstallerLaunchPlan(
						{
							installerExe: staged.installerExe,
							installDir: targetDir,
							logFile,
							// Some ElAmigos/RUNE scripts access Inno's progress-window
							// handle and crash under /VERYSILENT before patching starts.
							showProgressWindow: staged.installerFamily !== "rune",
							interactive: staged.installerFamily === "rune",
						},
						{ platform: context.platform, umu },
					);
					// A silent updater is otherwise a black box for minutes; surface
					// its phase and written bytes from the Inno log and directory
					// growth so the user sees a live bar and activity lines.
					const stopTracking = trackUpdaterActivity(
						logFile,
						targetDir,
						(activity) => {
							log(describeUpdaterActivity(stepLabel, activity));
							onStepProgress?.(updaterStepFraction(activity));
						},
					);
					// The updaters end by launching RapidCRC's verification GUI and
					// waiting on it; dismiss it whenever it appears so a silent
					// update can never hang on a window nobody is watching.
					const dismisser = umu
						? setInterval(() => {
								if (dismissBlockingCompanions(umu.winePrefix) > 0) {
									log("Dismissed the updater's verification window.");
								}
							}, 3_000)
						: undefined;
					const runeAutomation = new AbortController();
					const existingWindows =
						staged.installerFamily === "rune" && umu
							? snapshotGameWindows(umu.gameId)
							: new Set<string>();
					try {
						const running = runInstaller(plan, (line) => log(line.trim()));
						const automation =
							staged.installerFamily === "rune" && umu
								? driveRuneInstaller(
										umu.gameId,
										existingWindows,
										runeAutomation.signal,
									)
								: Promise.resolve(false);
						const guardedAutomation = automation.then(async (automated) => {
							if (staged.installerFamily === "rune" && umu && !automated) {
								await killWinePrefixProcesses(umu.winePrefix, { graceMs: 1_000 });
								throw new Error(
									"Could not control the RUNE updater window; the updater was stopped cleanly.",
								);
							}
							return automated;
						});
						const [result, automated] = await Promise.all([
							running,
							guardedAutomation,
						]);
						runeAutomation.abort();
						if (automated) {
							log("Started the RUNE updater and enabled its included crack.");
						}
						if (result.exitCode !== 0) {
							const logTail = readLogTail(logFile);
							if (logTail) {
								log(`Updater failure log:\n${logTail}`);
							}
						}
						return result.exitCode;
					} finally {
						runeAutomation.abort();
						stopTracking();
						if (dismisser) clearInterval(dismisser);
					}
				},
			});
		}

		const absoluteLaunchExecutable = isAbsolute(
			currentLibraryInfo.launchExecutable,
		)
			? currentLibraryInfo.launchExecutable
			: join(currentLibraryInfo.cwd, currentLibraryInfo.launchExecutable);
		const launchExecutable = relative(installDir, absoluteLaunchExecutable);
		const result = await applyUpdateTransaction({
			installDir,
			launchExecutable:
				launchExecutable.startsWith("..") || isAbsolute(launchExecutable)
					? basename(currentLibraryInfo.launchExecutable)
					: launchExecutable,
			targetVersion,
			steps,
			log,
			setProgress,
			createBackup,
		});

		// Keep downloaded packages available until the whole transaction commits.
		// A failed updater can then be retried without downloading the chain again.
		for (const artifact of downloadArtifacts) {
			fs.rmSync(artifact, { recursive: true, force: true });
		}
		return {
			...result,
			appliedPackages: selectedPackages.map(({ packagePath }) => packagePath),
		};
	} finally {
		fs.rmSync(stagingRoot, { recursive: true, force: true });
	}
}
