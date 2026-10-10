import { afterAll, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import { join } from "path";
import { isFirstRarVolume, selectExtractionParts } from "./rar-volume";

const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];

// CRC32, header size, type 1 (main), header flags, [extra size], archive
// flags, [volume number].
const rar5 = (
  headerFlags: number[],
  archiveFlags: number,
  rest: number[] = [],
) =>
  Buffer.from([
    ...RAR5_SIGNATURE,
    0,
    0,
    0,
    0,
    2 + headerFlags.length + rest.length,
    0x01,
    ...headerFlags,
    archiveFlags,
    ...rest,
    0,
    0,
    0,
    0,
  ]);

// CRC(2), type 0x73 (main), flags(2 LE), size(2), reserved(6).
const rar4 = (flags: number) =>
  Buffer.from([
    ...RAR4_SIGNATURE,
    0,
    0,
    0x73,
    flags & 0xff,
    flags >> 8,
    13,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);

const dir = fs.mkdtempSync(join(os.tmpdir(), "rar-volume-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: Buffer) => {
  fs.writeFileSync(join(dir, name), content);
  return name;
};
const at = (name: string) => join(dir, name);

describe("isFirstRarVolume", () => {
  it("accepts a RAR5 single-volume archive", () => {
    expect(isFirstRarVolume(at(write("single5.rar", rar5([0x00], 0x00))))).toBe(
      true,
    );
  });

  it("accepts the first volume of a RAR5 set", () => {
    expect(isFirstRarVolume(at(write("first5.rar", rar5([0x00], 0x01))))).toBe(
      true,
    );
  });

  it("rejects a RAR5 continuation volume", () => {
    expect(
      isFirstRarVolume(at(write("cont5.rar", rar5([0x00], 0x03, [0x01])))),
    ).toBe(false);
  });

  it("skips a RAR5 extra-area size before the archive flags", () => {
    expect(
      isFirstRarVolume(
        at(write("extra5.rar", rar5([0x01, 0x06], 0x03, [0x01]))),
      ),
    ).toBe(false);
  });

  it("accepts a RAR4 single-volume archive", () => {
    expect(isFirstRarVolume(at(write("single4.rar", rar4(0x0000))))).toBe(true);
  });

  it("accepts the first volume of a RAR4 set", () => {
    expect(isFirstRarVolume(at(write("first4.rar", rar4(0x0111))))).toBe(true);
  });

  it("rejects a RAR4 continuation volume", () => {
    expect(isFirstRarVolume(at(write("cont4.rar", rar4(0x0011))))).toBe(false);
  });

  it("accepts a file that is not a RAR archive", () => {
    expect(
      isFirstRarVolume(at(write("notrar.rar", Buffer.from("not a rar")))),
    ).toBe(true);
  });

  it("accepts a file it cannot read", () => {
    expect(isFirstRarVolume(at("missing.rar"))).toBe(true);
  });
});

describe("selectExtractionParts", () => {
  it("keeps only the first volume of one multi-volume set", () => {
    const parts = [
      { name: write("set.part0.rar", rar5([0x00], 0x01)) },
      { name: write("set.part1.rar", rar5([0x00], 0x03, [0x01])) },
      { name: write("set.part2.rar", rar5([0x00], 0x03, [0x02])) },
    ];
    expect(selectExtractionParts(dir, parts)).toEqual([parts[0]]);
  });

  it("keeps every part when the parts are independent archives", () => {
    const parts = [
      { name: write("ind.part0.rar", rar5([0x00], 0x00)) },
      { name: write("ind.part1.rar", rar5([0x00], 0x00)) },
    ];
    expect(selectExtractionParts(dir, parts)).toEqual(parts);
  });

  it("keeps every part when no first volume is recognised", () => {
    const parts = [
      { name: write("orphan.part1.rar", rar5([0x00], 0x03, [0x01])) },
      { name: write("orphan.part2.rar", rar5([0x00], 0x03, [0x02])) },
    ];
    expect(selectExtractionParts(dir, parts)).toEqual(parts);
  });
});
