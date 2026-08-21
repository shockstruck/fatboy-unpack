import fs from "fs";
import { basename, dirname, isAbsolute, join } from "path";
import type { LibraryInfo } from "ogi-addon";
import {
  buildInstallerLaunchPlan,
  convertUmuIdToGameId,
  runInstaller,
  type UmuContext,
} from "./installer-runner";
import { stageUpdatePackage } from "./update-staging";
import {
  applyUpdateTransaction,
  type UpdateStep,
} from "./update-transaction";
import { extractRepackVersion } from "./repack-store";

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
  targetVersion: string;
  currentLibraryInfo: LibraryInfo;
  context: UpdateExecutionContext;
  log: (message: string) => void;
}): Promise<{ backupDir: string }> {
  const { packages, targetVersion, currentLibraryInfo, context, log } = options;
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
      log(`Staging update package ${index + 1}/${packages.length}: ${basename(packagePath)}`);
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
