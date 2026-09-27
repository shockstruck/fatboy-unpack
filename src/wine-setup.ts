import { isAbsolute } from "path";

/**
 * Converts an absolute POSIX path (as seen by the host) into the Wine "Z:"
 * drive path Wine programs see for it. Pure: no filesystem access.
 */
export function toWineZPath(absPath: string): string {
  if (!isAbsolute(absPath)) {
    throw new Error(
      `toWineZPath requires an absolute path, got: "${absPath}"`,
    );
  }

  const withoutTrailingSlash =
    absPath.length > 1 ? absPath.replace(/\/+$/, "") : absPath;
  const windowsPath = withoutTrailingSlash.split("/").join("\\");
  return `Z:${windowsPath}`;
}

export type SilentSetupArgsInput = {
  infWinPath: string;
  logWinPath: string;
};

/**
 * Builds the Inno Setup argv for an unattended install. Pure.
 */
export function buildSilentSetupArgs({
  infWinPath,
  logWinPath,
}: SilentSetupArgsInput): string[] {
  return [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/SP-",
    "/NORESTART",
    `/LOADINF=${infWinPath}`,
    `/LOG=${logWinPath}`,
  ];
}

const INNO_EXIT_MESSAGES: Record<number, string> = {
  0: "Setup was successfully run to completion.",
  1: "Setup failed to initialize.",
  2: "Setup was cancelled before the actual installation started.",
  3: "A fatal error occurred while preparing to move to the next installation phase.",
  4: "A fatal error occurred during the actual installation process.",
  5: "Setup was cancelled during the actual installation process.",
  6: "The Setup process was forcefully terminated by a debugger.",
  7: "The preparation stage determined Setup cannot proceed with installation.",
  8: "The preparation stage determined Setup cannot proceed until the system restarts.",
};

/**
 * Maps an Inno Setup exit code to a human-readable message, per
 * https://jrsoftware.org/ishelp/topic_setupexitcodes.htm. Pure.
 */
export function describeInnoExitCode(code: number): string {
  const message = INNO_EXIT_MESSAGES[code];
  if (message) {
    return `Inno Setup exited with code ${code}: ${message}`;
  }
  return `Inno Setup exited with an unrecognized code ${code}.`;
}

export type SetupBranch = "silent" | "manual" | "win32";

/**
 * Decides which of the setup handler's three code paths runs. Pure.
 */
export function decideSetupBranch(
  platform: NodeJS.Platform,
  automateWineSetup: boolean,
): SetupBranch {
  if (platform === "win32") {
    return "win32";
  }
  return automateWineSetup ? "silent" : "manual";
}

/**
 * Builds the Inno Setup INF content. `installDir` is written verbatim as
 * `Dir=`; callers targeting Wine must pass an already-converted Z: path.
 * Pure.
 */
export function makeSetupINF(installDir: string, addBonus: boolean): string {
  return `
[Setup]
Lang=en
Dir=${installDir}
SetupType=custom
Components=text${addBonus ? ",bonus" : ""}
Tasks=
`;
}
