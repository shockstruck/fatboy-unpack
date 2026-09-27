import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideGameFolder,
  isBlockedExecutable,
  isBlockedPath,
  isValidExecutable,
  parsePEHeader,
  resolveExecutableChoice,
  scanExecutables,
  scoreCandidates,
  type ExecutableCandidate,
  type FolderEntry,
} from "./executable-detection";

const IMAGE_FILE_DLL = 0x2000;
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
const MACHINE_X64 = 0x8664;
const MACHINE_X86 = 0x14c;

// Builds a minimal synthetic PE header: DOS stub with "MZ" + e_lfanew,
// followed by a "PE\0\0" signature, a COFF header and just enough of the
// optional header to carry a Subsystem field. No real binary is involved.
function buildPEBuffer(opts: {
  machine?: number;
  isDll?: boolean;
  subsystem?: number;
}): Buffer {
  const peOffset = 0x40;
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.writeUInt32LE(0x00004550, peOffset); // "PE\0\0"
  buffer.writeUInt16LE(opts.machine ?? MACHINE_X64, peOffset + 4);
  const characteristics = opts.isDll ? IMAGE_FILE_DLL : 0x0102;
  buffer.writeUInt16LE(characteristics, peOffset + 22);
  const optionalHeaderOffset = peOffset + 24;
  buffer.writeUInt16LE(
    opts.subsystem ?? IMAGE_SUBSYSTEM_WINDOWS_GUI,
    optionalHeaderOffset + 68,
  );
  return buffer;
}

describe("parsePEHeader / isValidExecutable", () => {
  it("accepts a GUI x64 executable", () => {
    const pe = parsePEHeader(buildPEBuffer({ machine: MACHINE_X64 }));
    expect(pe).not.toBeNull();
    expect(isValidExecutable(pe)).toBe(true);
  });

  it("rejects a buffer without an MZ signature", () => {
    const pe = parsePEHeader(Buffer.alloc(256));
    expect(pe).toBeNull();
    expect(isValidExecutable(pe)).toBe(false);
  });

  it("rejects a DLL renamed to .exe", () => {
    const pe = parsePEHeader(buildPEBuffer({ isDll: true }));
    expect(pe).not.toBeNull();
    expect(pe?.isDll).toBe(true);
    expect(isValidExecutable(pe)).toBe(false);
  });

  it("rejects a non-GUI (console) subsystem", () => {
    const pe = parsePEHeader(
      buildPEBuffer({ subsystem: IMAGE_SUBSYSTEM_WINDOWS_CUI }),
    );
    expect(isValidExecutable(pe)).toBe(false);
  });
});

describe("isBlockedExecutable", () => {
  const blocked = [
    "UnityCrashHandler64.exe",
    "unins000.exe",
    "UnInstall.exe",
    "vc_redist.x64.exe",
    "SomeGameRedistInstaller.exe",
    "dxsetup.exe",
    "dxwebsetup.exe",
    "crashpad_handler.exe",
    "CrashReportClient.exe",
    "UE4PrereqSetup_x64.exe",
    "UEPrereqSetup_x64.exe",
    "AntiCheatExpert_BE.exe",
    "EasyAntiCheat.exe",
    "dotNetFx40Setup.exe",
  ];

  it.each(blocked)("blocks %s", (name) => {
    expect(isBlockedExecutable(name)).toBe(true);
  });

  it("does not block a plausible game executable", () => {
    expect(isBlockedExecutable("Game-Win64-Shipping.exe")).toBe(false);
    expect(isBlockedExecutable("Launcher.exe")).toBe(false);
  });
});

describe("isBlockedPath", () => {
  it("blocks noise directories anywhere in the path", () => {
    expect(isBlockedPath("_CommonRedist/setup.exe")).toBe(true);
    expect(isBlockedPath("Game/_Redist/setup.exe")).toBe(true);
    expect(isBlockedPath("__MACOSX/Game.exe")).toBe(true);
  });

  it("blocks Unreal Engine tooling paths", () => {
    expect(isBlockedPath("Engine/Extras/Redist/en-us/tool.exe")).toBe(true);
    expect(
      isBlockedPath("Engine/Binaries/ThirdParty/PhysX/tool.exe"),
    ).toBe(true);
    expect(
      isBlockedPath("Engine/Binaries/Win64/CrashReportClient.exe"),
    ).toBe(true);
  });

  it("does not block a normal nested game path", () => {
    expect(isBlockedPath("Game/Binaries/Win64/Game-Win64-Shipping.exe")).toBe(
      false,
    );
  });
});

describe("decideGameFolder", () => {
  const entries = (
    ...items: Array<[string, boolean]>
  ): FolderEntry[] =>
    items.map(([name, isDirectory]) => ({ name, isDirectory }));

  it("(a) flat layout resolves with no prompt", () => {
    const decision = decideGameFolder(
      entries(["Game.exe", false], ["data.bin", false], ["archive.rar", false]),
      ["archive.rar"],
    );
    expect(decision.action).toBe("flat");
  });

  it("(b) a single differently-named top-level dir collapses", () => {
    const decision = decideGameFolder(
      entries(["Some.Release.Name-CODEX", true], ["archive.rar", false]),
      ["archive.rar"],
    );
    expect(decision).toEqual({
      action: "collapse",
      targetDir: "Some.Release.Name-CODEX",
    });
  });

  it("(c) _CommonRedist plus a game dir collapses to the game dir", () => {
    const decision = decideGameFolder(
      entries(
        ["_CommonRedist", true],
        ["MyGame", true],
        ["archive.rar", false],
      ),
      ["archive.rar"],
    );
    expect(decision).toEqual({ action: "collapse", targetDir: "MyGame" });
  });

  it("(d) two plausible game dirs is ambiguous and prompts", () => {
    const decision = decideGameFolder(
      entries(["GameV1", true], ["GameV2", true], ["archive.rar", false]),
      ["archive.rar"],
    );
    expect(decision.action).toBe("ambiguous");
  });

  it("is ambiguous when a lone non-noise dir still has extra loose files", () => {
    const decision = decideGameFolder(
      entries(
        ["MyGame", true],
        ["archive.rar", false],
        ["readme.txt", false],
      ),
      ["archive.rar"],
    );
    expect(decision.action).toBe("ambiguous");
  });
});

describe("resolveExecutableChoice", () => {
  const candidate = (
    relPath: string,
    score: number,
    size = 1000,
    depth = 0,
  ) => ({ relPath, size, pe: null, score, depth });

  it("auto-picks the only surviving candidate, even at a low score", () => {
    const result = resolveExecutableChoice([candidate("Game.exe", 0)]);
    expect(result.autoPick?.relPath).toBe("Game.exe");
  });

  it("never auto-picks when there are no candidates", () => {
    const result = resolveExecutableChoice([]);
    expect(result.autoPick).toBeNull();
    expect(result.ranked).toEqual([]);
  });

  it("auto-picks when the top score beats the runner-up by >= 0.3", () => {
    const result = resolveExecutableChoice([
      candidate("Game.exe", 1.0),
      candidate("Other.exe", 0.5),
    ]);
    expect(result.autoPick?.relPath).toBe("Game.exe");
  });

  it("never silently picks below the confidence margin, and keeps the list sorted", () => {
    const result = resolveExecutableChoice([
      candidate("Game.exe", 1.0),
      candidate("GameClassic.exe", 0.707),
    ]);
    expect(result.autoPick).toBeNull();
    expect(result.ranked.map((c) => c.relPath)).toEqual([
      "Game.exe",
      "GameClassic.exe",
    ]);
    expect(result.ranked[0].score).toBeGreaterThanOrEqual(
      result.ranked[1].score,
    );
  });
});

describe("scoreCandidates", () => {
  it("down-ranks *launcher* instead of excluding it", () => {
    const candidates: ExecutableCandidate[] = [
      {
        relPath: "Neon-Drift.exe",
        size: 1000,
        pe: { machine: MACHINE_X64, isDll: false, subsystem: 2 },
      },
      {
        relPath: "Neon-Drift-Launcher.exe",
        size: 1000,
        pe: { machine: MACHINE_X64, isDll: false, subsystem: 2 },
      },
    ];
    const scored = scoreCandidates(candidates, "Neon Drift", "Neon Drift");
    const main = scored.find((c) => c.relPath === "Neon-Drift.exe")!;
    const launcher = scored.find(
      (c) => c.relPath === "Neon-Drift-Launcher.exe",
    )!;
    expect(main.score).toBeGreaterThan(launcher.score);
  });

  it("produces a near-tie that the confidence rule refuses to auto-pick", () => {
    const candidates: ExecutableCandidate[] = [
      {
        relPath: "Neon-Drift.exe",
        size: 1000,
        pe: { machine: MACHINE_X64, isDll: false, subsystem: 2 },
      },
      {
        relPath: "Neon-Drift-Classic.exe",
        size: 1000,
        pe: { machine: MACHINE_X64, isDll: false, subsystem: 2 },
      },
    ];
    const scored = scoreCandidates(candidates, "Neon Drift", "Neon Drift");
    const choice = resolveExecutableChoice(scored);
    expect(choice.autoPick).toBeNull();
    expect(choice.ranked[0].relPath).toBe("Neon-Drift.exe");
  });

  it("prefers x64 over x86 when names tie exactly", () => {
    const candidates: ExecutableCandidate[] = [
      {
        relPath: "Game-x86.exe",
        size: 1000,
        pe: { machine: MACHINE_X86, isDll: false, subsystem: 2 },
      },
      {
        relPath: "Game-x64.exe",
        size: 1000,
        pe: { machine: MACHINE_X64, isDll: false, subsystem: 2 },
      },
    ];
    // Neither filename shares tokens with the game name, so both land at
    // score 0 before the machine-type bias is applied.
    const scored = scoreCandidates(candidates, "Some Other Title", "Some Other Title");
    expect(scored[0].relPath).toBe("Game-x64.exe");
  });
});

describe("scanExecutables + scoring pipeline (synthetic fixtures on disk)", () => {
  it("ranks the shipping/main exe first and excludes every noise file", async () => {
    const root = await mkdtemp(join(tmpdir(), "fatboy-exe-test-"));
    try {
      await mkdir(join(root, "Game", "Binaries", "Win64"), {
        recursive: true,
      });

      const shippingPath = join(
        root,
        "Game",
        "Binaries",
        "Win64",
        "Game-Win64-Shipping.exe",
      );
      const bootstrapperPath = join(root, "Game.exe");
      const unityCrashPath = join(root, "UnityCrashHandler64.exe");
      const ue4PrereqPath = join(root, "UE4PrereqSetup_x64.exe");
      const uninstallPath = join(root, "unins000.exe");
      const battlEyePath = join(root, "AntiCheat_BE.exe");
      const dllAsExePath = join(root, "SomeLibrary.exe");

      // Real game exe: large, valid GUI PE.
      await writeFile(
        shippingPath,
        Buffer.concat([
          buildPEBuffer({ machine: MACHINE_X64 }),
          Buffer.alloc(2_000_000),
        ]),
      );
      // Bootstrapper: small, still a valid GUI PE.
      await writeFile(bootstrapperPath, buildPEBuffer({ machine: MACHINE_X64 }));
      // Noise, name-blocked, but still a technically-valid PE.
      await writeFile(
        unityCrashPath,
        buildPEBuffer({ machine: MACHINE_X64 }),
      );
      await writeFile(ue4PrereqPath, buildPEBuffer({ machine: MACHINE_X64 }));
      await writeFile(uninstallPath, buildPEBuffer({ machine: MACHINE_X64 }));
      await writeFile(battlEyePath, buildPEBuffer({ machine: MACHINE_X64 }));
      // A DLL renamed to .exe: passes the blocklist by name, rejected by PE.
      await writeFile(dllAsExePath, buildPEBuffer({ isDll: true }));

      const candidates = await scanExecutables(root, 4);
      const relPaths = candidates.map((c) => c.relPath).sort();

      // The blocklisted-by-name files never even become candidates.
      expect(relPaths).not.toContain("UnityCrashHandler64.exe");
      expect(relPaths).not.toContain("UE4PrereqSetup_x64.exe");
      expect(relPaths).not.toContain("unins000.exe");
      expect(relPaths).not.toContain("AntiCheat_BE.exe");
      // The DLL renamed to .exe is scanned but must fail PE validation.
      expect(relPaths).toContain("SomeLibrary.exe");

      const scored = scoreCandidates(candidates, "Elden Ring", "Elden Ring");
      const survivors = scored.map((c) => c.relPath);

      expect(survivors).not.toContain("SomeLibrary.exe");
      expect(survivors).toContain(join("Game", "Binaries", "Win64", "Game-Win64-Shipping.exe"));
      expect(survivors).toContain("Game.exe");

      // Neither filename shares a token with "Elden Ring", so both land at
      // score 0 and the tiebreaker (larger file first) decides.
      expect(scored[0].relPath).toBe(
        join("Game", "Binaries", "Win64", "Game-Win64-Shipping.exe"),
      );

      const choice = resolveExecutableChoice(scored);
      expect(choice.autoPick).toBeNull(); // tied at score 0 → never silently picked
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not descend into noise directories or exceed the depth limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "fatboy-exe-depth-"));
    try {
      await mkdir(join(root, "_CommonRedist"), { recursive: true });
      await writeFile(
        join(root, "_CommonRedist", "vcredist_x64.exe"),
        buildPEBuffer({}),
      );

      const deepDir = join(root, "a", "b", "c", "d", "e");
      await mkdir(deepDir, { recursive: true });
      await writeFile(join(deepDir, "TooDeep.exe"), buildPEBuffer({}));

      const shallowDir = join(root, "a", "b");
      await writeFile(join(shallowDir, "JustRight.exe"), buildPEBuffer({}));

      const candidates = await scanExecutables(root, 4);
      const relPaths = candidates.map((c) => c.relPath);

      expect(relPaths).not.toContain(join("_CommonRedist", "vcredist_x64.exe"));
      expect(relPaths).not.toContain(join("a", "b", "c", "d", "e", "TooDeep.exe"));
      expect(relPaths).toContain(join("a", "b", "JustRight.exe"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
