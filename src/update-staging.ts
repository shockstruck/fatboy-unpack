import fs from "fs";
import { spawn } from "child_process";
import { basename, dirname, isAbsolute, join, normalize } from "path";

// Stages update packages before anything touches the installation. Every
// package gets its own directory because ElAmigos companion payloads reuse the
// same file name (elamigos-1.bin) across updates.

export type StagedUpdate = {
  /** Isolated directory holding this update's extracted files. */
  stagingDir: string;
  /** The outer installer to invoke. Internal batch/patch tools are never run directly. */
  installerExe: string;
  /** Companion payloads that must stay siblings of the installer. */
  companionFiles: string[];
};

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
          new Error(`${basename(command)} exited with code ${code}: ${output.slice(-2048)}`),
        );
      }
    });
  });
}

function archiveTool(): { command: string; list: string[]; extract: string[] } {
  if (process.platform === "win32") {
    const sevenZip = "C:\\Program Files\\7-Zip\\7z.exe";
    return { command: sevenZip, list: ["l", "-ba", "-slt"], extract: ["x", "-y"] };
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

function findStagedInstaller(stagingDir: string): StagedUpdate {
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

  const exes = files.filter((file) => file.toLowerCase().endsWith(".exe"));
  if (exes.length === 0) {
    throw new Error("No installer .exe found in the update package");
  }
  if (exes.length > 1) {
    throw new Error(
      `Expected one installer .exe in the update package, found: ${exes
        .map((exe) => basename(exe))
        .join(", ")}`,
    );
  }

  return {
    stagingDir,
    installerExe: exes[0],
    companionFiles: files.filter((file) => file !== exes[0]),
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
        : [...tool.extract, packagePath, stagingDir + "/"];
    await runTool(tool.command, args);
  } else {
    // A bare installer exe: copy it plus any sibling companion payloads.
    fs.cpSync(dirname(packagePath), stagingDir, { recursive: true });
  }

  return findStagedInstaller(stagingDir);
}
