import { describe, expect, it } from "bun:test";
import { resolveUmuBin } from "./umu-path";

const DEFAULT_BIN = "/home/u/.local/share/OpenGameInstaller/bin/umu/umu-run";
const yes = () => true;
const no = () => false;

describe("resolveUmuBin", () => {
  it("uses the OGI zipapp when OGI_UMU_RUN is unset", () => {
    expect(resolveUmuBin({ HOME: "/home/u" }, yes)).toBe(DEFAULT_BIN);
  });

  it("ignores a relative OGI_UMU_RUN", () => {
    expect(
      resolveUmuBin({ HOME: "/home/u", OGI_UMU_RUN: "bin/umu-run" }, yes),
    ).toBe(DEFAULT_BIN);
  });

  it("ignores an absolute OGI_UMU_RUN that is not executable", () => {
    expect(
      resolveUmuBin({ HOME: "/home/u", OGI_UMU_RUN: "/nix/store/x/umu-run" }, no),
    ).toBe(DEFAULT_BIN);
  });

  it("uses an absolute, executable OGI_UMU_RUN", () => {
    const seen: string[] = [];
    const bin = resolveUmuBin(
      { HOME: "/home/u", OGI_UMU_RUN: "/nix/store/x/bin/umu-run" },
      (p) => {
        seen.push(p);
        return true;
      },
    );
    expect(bin).toBe("/nix/store/x/bin/umu-run");
    expect(seen).toEqual(["/nix/store/x/bin/umu-run"]);
  });

  it("treats an empty OGI_UMU_RUN as unset", () => {
    expect(resolveUmuBin({ HOME: "/home/u", OGI_UMU_RUN: "" }, yes)).toBe(
      DEFAULT_BIN,
    );
  });
});
