import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import { join } from "path";
import {
  applyUpdateTransaction,
  backupDirFor,
  discardUpdateBackup,
  recoverUpdateTransaction,
  rollbackToBackup,
  shadowDirFor,
} from "./update-transaction";

let root: string;
let installDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "fatboy-txn-"));
  installDir = join(root, "Game");
  fs.mkdirSync(installDir);
  fs.writeFileSync(join(installDir, "game.exe"), "v1.00");
  fs.writeFileSync(join(installDir, "data.bin"), "data");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const noLog = (): void => {};

describe("update transaction", () => {
  test("patches the shadow, commits, and retains a backup", async () => {
    const patchedDirs: string[] = [];
    const { backupDir } = await applyUpdateTransaction({
      installDir,
      launchExecutable: "game.exe",
      targetVersion: "v1.05",
      log: noLog,
      steps: [
        {
          label: "v1.05",
          run: async (targetDir) => {
            patchedDirs.push(targetDir);
            fs.writeFileSync(join(targetDir, "game.exe"), "v1.05");
            return 0;
          },
        },
      ],
    });

    expect(patchedDirs).toEqual([shadowDirFor(installDir)]);
    expect(fs.readFileSync(join(installDir, "game.exe"), "utf-8")).toBe(
      "v1.05",
    );
    expect(fs.readFileSync(join(backupDir, "game.exe"), "utf-8")).toBe("v1.00");

    discardUpdateBackup(installDir);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  test("leaves the live install untouched when an installer fails", async () => {
    const transaction = applyUpdateTransaction({
      installDir,
      launchExecutable: "game.exe",
      targetVersion: "v1.05",
      log: noLog,
      steps: [{ label: "v1.05", run: async () => 2 }],
    });

    await expect(transaction).rejects.toThrow("exited with code 2");
    expect(fs.readFileSync(join(installDir, "game.exe"), "utf-8")).toBe(
      "v1.00",
    );
    expect(fs.existsSync(shadowDirFor(installDir))).toBe(false);
  });

  test("fails validation when the executable disappears or temp files remain", async () => {
    const missingExe = applyUpdateTransaction({
      installDir,
      launchExecutable: "game.exe",
      targetVersion: "v1.05",
      log: noLog,
      steps: [
        {
          label: "v1.05",
          run: async (targetDir) => {
            fs.rmSync(join(targetDir, "game.exe"));
            return 0;
          },
        },
      ],
    });
    await expect(missingExe).rejects.toThrow("executable");

    const leftovers = applyUpdateTransaction({
      installDir,
      launchExecutable: "game.exe",
      targetVersion: "v1.05",
      log: noLog,
      steps: [
        {
          label: "v1.05",
          run: async (targetDir) => {
            fs.writeFileSync(join(targetDir, "delta.patch"), "partial");
            return 0;
          },
        },
      ],
    });
    await expect(leftovers).rejects.toThrow("temporary files");
    expect(fs.readFileSync(join(installDir, "game.exe"), "utf-8")).toBe(
      "v1.00",
    );
  });

  test("refuses to start while a previous backup is unconfirmed", async () => {
    fs.mkdirSync(backupDirFor(installDir));

    const transaction = applyUpdateTransaction({
      installDir,
      launchExecutable: "game.exe",
      targetVersion: "v1.05",
      log: noLog,
      steps: [],
    });
    await expect(transaction).rejects.toThrow("backup still exists");
  });

  test("rolls back to the retained backup", async () => {
    await applyUpdateTransaction({
      installDir,
      launchExecutable: "game.exe",
      targetVersion: "v1.05",
      log: noLog,
      steps: [
        {
          label: "v1.05",
          run: async (targetDir) => {
            fs.writeFileSync(join(targetDir, "game.exe"), "v1.05-broken");
            return 0;
          },
        },
      ],
    });

    rollbackToBackup(installDir);
    expect(fs.readFileSync(join(installDir, "game.exe"), "utf-8")).toBe(
      "v1.00",
    );
    expect(fs.existsSync(backupDirFor(installDir))).toBe(false);
  });

  test("recovery discards an orphaned shadow and finishes interrupted commits", () => {
    // Orphaned shadow with no journal.
    fs.mkdirSync(shadowDirFor(installDir));
    recoverUpdateTransaction(installDir, noLog);
    expect(fs.existsSync(shadowDirFor(installDir))).toBe(false);

    // Interrupted between the two commit renames: install dir gone, backup present.
    fs.renameSync(installDir, backupDirFor(installDir));
    fs.writeFileSync(
      join(root, ".Game.fatboy-journal"),
      JSON.stringify({
        phase: "committing",
        installDir,
        shadowDir: shadowDirFor(installDir),
        backupDir: backupDirFor(installDir),
        targetVersion: "v1.05",
      }),
    );
    recoverUpdateTransaction(installDir, noLog);
    expect(fs.existsSync(installDir)).toBe(true);
    expect(fs.readFileSync(join(installDir, "game.exe"), "utf-8")).toBe(
      "v1.00",
    );
  });
});
