import fs from "fs";
import { join } from "path";

const RAR4_SIGNATURE = Buffer.from("Rar!\x1a\x07\x00", "latin1");
const RAR5_SIGNATURE = Buffer.from("Rar!\x1a\x07\x01\x00", "latin1");

// RAR 1.5–4.x main header flags.
const MHD_VOLUME = 0x0001;
const MHD_FIRSTVOLUME = 0x0100;

// RAR 5 main header: header flag "extra area present", "data area present",
// and archive flag "volume number field present" (set in every volume but
// the first).
const HFL_EXTRA = 0x0001;
const HFL_DATA = 0x0002;
const MHFL_VOLNUMBER = 0x0002;

// False only for a continuation volume of a multi-volume set: unrar already
// reads it while extracting the set's first volume, and refuses it on its own
// ("You need to start extraction from a previous volume", exit code 6).
// Anything it cannot read or recognise counts as a first volume, so the
// caller extracts it as before.
export function isFirstRarVolume(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return true;
  }
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);

    if (n >= 12 && buf.subarray(0, 7).equals(RAR4_SIGNATURE)) {
      // Main header at offset 7: CRC(2), type(1), flags(2 LE).
      if (buf[9] !== 0x73) return true;
      const flags = buf.readUInt16LE(10);
      return (flags & MHD_VOLUME) === 0 || (flags & MHD_FIRSTVOLUME) !== 0;
    }

    if (n >= 16 && buf.subarray(0, 8).equals(RAR5_SIGNATURE)) {
      // Main header at offset 8: CRC32(4), then vints (7 bits each, little
      // endian, 0x80 = more): size, type, header flags, [extra size],
      // [data size], archive flags.
      let pos = 12;
      const vint = (): number => {
        let value = 0;
        let shift = 0;
        while (pos < n) {
          const byte = buf[pos++];
          value += (byte & 0x7f) * 2 ** shift;
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }
        return value;
      };
      vint();
      if (vint() !== 1) return true;
      const headerFlags = vint();
      if (headerFlags & HFL_EXTRA) vint();
      if (headerFlags & HFL_DATA) vint();
      return (vint() & MHFL_VOLNUMBER) === 0;
    }

    return true;
  } catch {
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// The parts that need their own extraction run. FuckingFast names every link
// partN.rar whether the parts are independent archives or one multi-volume
// set; a set is extracted once, from its first volume. If no part reads as a
// first volume, every part is kept and unrar reports the real problem.
export function selectExtractionParts<T extends { name: string }>(
  dir: string,
  parts: T[],
): T[] {
  const firstVolumes = parts.filter((part) =>
    isFirstRarVolume(join(dir, part.name)),
  );
  return firstVolumes.length > 0 ? firstVolumes : parts;
}
