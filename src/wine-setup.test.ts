import { describe, expect, it } from "bun:test";
import {
  buildSilentSetupArgs,
  decideSetupBranch,
  describeInnoExitCode,
  makeSetupINF,
  toWineZPath,
} from "./wine-setup";

describe("toWineZPath", () => {
  it("converts a nested absolute path with spaces", () => {
    expect(toWineZPath("/home/user/Games/My Game/INSTALL HERE")).toBe(
      "Z:\\home\\user\\Games\\My Game\\INSTALL HERE",
    );
  });

  it("strips a trailing slash", () => {
    expect(toWineZPath("/home/user/Games/")).toBe("Z:\\home\\user\\Games");
  });

  it("throws on a relative path", () => {
    expect(() => toWineZPath("relative/path")).toThrow();
  });
});

describe("buildSilentSetupArgs", () => {
  it("returns the exact argv", () => {
    expect(
      buildSilentSetupArgs({
        infWinPath: "Z:\\home\\user\\Games\\fatboy-setup.inf",
        logWinPath: "Z:\\home\\user\\Games\\fatboy-setup.log",
      }),
    ).toEqual([
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/SP-",
      "/NORESTART",
      "/LOADINF=Z:\\home\\user\\Games\\fatboy-setup.inf",
      "/LOG=Z:\\home\\user\\Games\\fatboy-setup.log",
    ]);
  });
});

describe("describeInnoExitCode", () => {
  const documented: Array<[number, string]> = [
    [0, "Setup was successfully run to completion."],
    [1, "Setup failed to initialize."],
    [2, "Setup was cancelled before the actual installation started."],
    [
      3,
      "A fatal error occurred while preparing to move to the next installation phase.",
    ],
    [4, "A fatal error occurred during the actual installation process."],
    [5, "Setup was cancelled during the actual installation process."],
    [6, "The Setup process was forcefully terminated by a debugger."],
    [
      7,
      "The preparation stage determined Setup cannot proceed with installation.",
    ],
    [
      8,
      "The preparation stage determined Setup cannot proceed until the system restarts.",
    ],
  ];

  it.each(documented)("maps code %d", (code, message) => {
    expect(describeInnoExitCode(code)).toBe(
      `Inno Setup exited with code ${code}: ${message}`,
    );
  });

  it("falls back for an unrecognized code", () => {
    expect(describeInnoExitCode(42)).toBe(
      "Inno Setup exited with an unrecognized code 42.",
    );
  });
});

describe("decideSetupBranch", () => {
  it("always picks win32 on Windows regardless of automateWineSetup", () => {
    expect(decideSetupBranch("win32", true)).toBe("win32");
    expect(decideSetupBranch("win32", false)).toBe("win32");
  });

  it("picks silent on Linux when automateWineSetup is true", () => {
    expect(decideSetupBranch("linux", true)).toBe("silent");
  });

  it("picks manual on Linux when automateWineSetup is false", () => {
    expect(decideSetupBranch("linux", false)).toBe("manual");
  });

  it("picks silent on darwin when automateWineSetup is true", () => {
    expect(decideSetupBranch("darwin", true)).toBe("silent");
  });

  it("picks manual on darwin when automateWineSetup is false", () => {
    expect(decideSetupBranch("darwin", false)).toBe("manual");
  });
});

describe("makeSetupINF", () => {
  it("writes the Wine Z: install dir verbatim as Dir=", () => {
    const inf = makeSetupINF(
      "Z:\\home\\user\\Games\\My Game\\INSTALL HERE",
      false,
    );
    expect(inf).toContain("Dir=Z:\\home\\user\\Games\\My Game\\INSTALL HERE");
    expect(inf).toContain("Components=text");
    expect(inf).not.toContain(",bonus");
  });

  it("adds the bonus component when requested", () => {
    const inf = makeSetupINF("Z:\\home\\user\\Games", true);
    expect(inf).toContain("Components=text,bonus");
  });
});
