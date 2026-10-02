import { accessSync, constants } from "fs";
import { isAbsolute, join } from "path";

/** Env var OpenGameInstaller sets to point addons at a packager's `umu-run`. */
export const OGI_UMU_RUN_ENV = "OGI_UMU_RUN";

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the `umu-run` to launch setup.exe with. Same rules as OpenGameInstaller's
 * `resolveUmuRunExecutable`: `OGI_UMU_RUN` wins when it is an absolute,
 * executable path; otherwise the zipapp OGI downloads under
 * `~/.local/share/OpenGameInstaller/bin/umu/umu-run`. Pure apart from the
 * injected `isExecutable`.
 */
export function resolveUmuBin(
  env: NodeJS.ProcessEnv,
  isExecutable: (path: string) => boolean = isExecutableFile,
): string {
  const override = env[OGI_UMU_RUN_ENV];
  if (override && isAbsolute(override) && isExecutable(override)) {
    return override;
  }
  return join(
    env.HOME ?? "",
    ".local",
    "share",
    "OpenGameInstaller",
    "bin",
    "umu",
    "umu-run",
  );
}
