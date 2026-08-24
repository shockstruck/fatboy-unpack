import fs from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { LibraryInfo } from "ogi-addon";
import {
	buildInstallerLaunchPlan,
	convertUmuIdToGameId,
	runInstaller,
	type UmuContext,
} from "./installer-runner";
import { extractRepackVersion } from "./repack-store";
import { stageUpdatePackage } from "./update-staging";
import { applyUpdateTransaction, type UpdateStep } from "./update-transaction";

// Orchestrates one local-package update: stage everything first, then apply
// the chain to a shadow copy through UpdateTransaction. Callers only supply
// the package files and the library entry being updated.

export type UpdateExecutionContext = {
	platform: NodeJS.Platform;
	umuRunPath: string;
	homeDir: string;
};

function buildUmuContext(
	libraryInfo: LibraryInfo,
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

/** Resolves the installation directory the update must patch. */
export function installDirOf(libraryInfo: LibraryInfo): string {
	return libraryInfo.cwd;
}

export async function applyLocalUpdatePackages(options: {
	/** Package files (.rar or updater .exe) in prerequisite order. */
	packages: string[];
	/** Downloaded files OGI placed in the live directory for this update. */
	downloadArtifacts?: string[];
	targetVersion: string;
	currentLibraryInfo: LibraryInfo;
	context: UpdateExecutionContext;
	log: (message: string) => void;
}): Promise<{ backupDir: string }> {
	const {
		packages,
		downloadArtifacts = [],
		targetVersion,
		currentLibraryInfo,
		context,
		log,
	} = options;
	const installDir = installDirOf(currentLibraryInfo);
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
		const steps: UpdateStep[] = [];
		for (const [index, packagePath] of packages.entries()) {
			log(
				`Staging update package ${index + 1}/${packages.length}: ${basename(packagePath)}`,
			);
			const staged = await stageUpdatePackage(packagePath, stagingRoot, index);
			const label = extractRepackVersion(basename(packagePath));
			steps.push({
				label: label === "unknown" ? `package ${index + 1}` : label,
				run: async (targetDir) => {
					const plan = buildInstallerLaunchPlan(
						{
							installerExe: staged.installerExe,
							installDir: targetDir,
							logFile: join(staged.stagingDir, "installer.log"),
						},
						{
							platform: context.platform,
							umu:
								context.platform === "win32"
									? undefined
									: buildUmuContext(currentLibraryInfo, context),
						},
					);
					const result = await runInstaller(plan, (line) => log(line.trim()));
					return result.exitCode;
				},
			});
		}

		// Direct downloads land beside the live game because OGI's own old_files
		// staging is disabled for incremental installers. Once every package has
		// been extracted into our external staging root, remove those payloads so
		// they are neither copied into the shadow nor left in the updated game.
		for (const artifact of downloadArtifacts) {
			fs.rmSync(artifact, { force: true });
		}

		return await applyUpdateTransaction({
			installDir,
			launchExecutable: isAbsolute(currentLibraryInfo.launchExecutable)
				? basename(currentLibraryInfo.launchExecutable)
				: currentLibraryInfo.launchExecutable,
			targetVersion,
			steps,
			log,
		});
	} finally {
		fs.rmSync(stagingRoot, { recursive: true, force: true });
	}
}
