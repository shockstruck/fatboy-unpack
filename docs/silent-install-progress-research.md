# Silent FitGirl install progress research

Research date: 2026-08-25. Sources are primary documentation or source code. “Verified” means the cited source directly establishes the statement; “inference” means the conclusion follows from those facts; “unverified” means it needs a live installer experiment.

## Executive summary

| Signal | Assessment | Why |
| --- | --- | --- |
| Current install-directory byte total | Useful corroborating signal, but not a complete progress meter | It measures materialized output and naturally stops during CRC work; the repository currently polls it every 5 seconds and caps at 99 ([`src/install-progress.ts`](../src/install-progress.ts), [`src/main.ts`](../src/main.ts)). |
| `/LOG` file size/content | Useful lifecycle/debug signal; not a dependable extraction meter | Inno logs its own file operations and `[Run]` launch details. A `[Run]` child’s output is only captured when `logoutput` is selected; ordinary child output is not automatically an extraction-progress channel. ([Inno `/LOG` documentation](https://jrsoftware.org/ishelp/topic_setupcmdline.htm), [Inno logging source](https://github.com/jrsoftware/issrc/blob/main/Projects/Src/Setup.LoggingFunc.pas), [Run source](https://github.com/jrsoftware/issrc/blob/main/Projects/Src/Setup.MainFunc.pas)) |
| FreeArc/unarc callback | Real progress exists inside the DLL interface, but FitGirl’s customized installer does not expose it to this addon | The FreeArc DLL has `read`, `write`, `file`, and timer callbacks. The callback is consumed by the Inno script/UI integration, not emitted as a standard log or pipe. ([`unarcdll.cpp`](https://github.com/svn2github/freearc/blob/master/Unarc/unarcdll.cpp), [FreeArc Inno example](https://github.com/svn2github/freearc/blob/master/Unarc/InnoSetup/FreeArc_Example-Ext.iss)) |
| `/proc/<pid>/fdinfo/<fd>` `pos` | Most promising experimental primary signal | Linux reports the current offset of an opened file. For an `fg-*.bin` descriptor, that can approximate compressed bytes consumed, with the sum of selected bin sizes as a bounded denominator. It is not yet verified against FitGirl’s Wine/unarc implementation. ([kernel `proc(5)` documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html#proc-pid-fdinfo-fd-information-about-opened-file)) |
| Registry/window messages/named pipe | No supported machine-readable silent-Inno progress interface found | The reviewed Inno command-line documentation and source expose logging and `[Run]` output handling, not a documented external progress protocol. Treat any reverse-engineered window message as version-specific and unverified. |

The concrete fix should use the page’s “HDD space after installation” value when available, fall back to “Original Size”, and retain directory growth as a corroborating signal. In parallel, prototype fdinfo sampling under Wine. During the final verification tail, stop pretending that output growth equals work completed: show a bounded “verifying / finishing installation” phase and complete only when Setup exits successfully.

## 1. Inno `/LOG` during install

### Verified facts

Inno documents `/LOG` as a technical log detailing file installation and `[Run]` actions. It explicitly says the format is not designed to be machine-parsable and is subject to change ([Setup command-line parameters](https://jrsoftware.org/ishelp/topic_setupcmdline.htm)). `/LOG="filename"` overwrites the requested fixed file or aborts if it cannot create it ([same documentation](https://jrsoftware.org/ishelp/topic_setupcmdline.htm)).

The current Inno source opens a `TTextFileWriter`, writes a timestamped line for each `Log` call, and writes through `WriteFile`; finalization adds `Log closed.` and frees the writer ([`Setup.LoggingFunc.pas`](https://github.com/jrsoftware/issrc/blob/main/Projects/Src/Setup.LoggingFunc.pas), [`Shared.FileClass.pas`](https://github.com/jrsoftware/issrc/blob/main/Projects/Src/Shared.FileClass.pas)). There is no explicit `FlushFileBuffers` or periodic flush in this logging path. Therefore, a reader can generally see writes as the Windows file handle advances, but durability/visibility timing is an implementation/filesystem detail, not a documented polling contract. This is a source-level fact plus an inference about polling suitability.

For `[Run]`, the source logs a `-- Run entry --` block, current/original-user mode, execution type, filename, parameters (unless `dontlogparameters`), and working directory ([`Setup.MainFunc.pas`](https://github.com/jrsoftware/issrc/blob/main/Projects/Src/Setup.MainFunc.pas)). It creates an output reader only when the entry has `logoutput`; otherwise the child’s stdout/stderr is not wired into the Inno log. The public `[Run]` documentation likewise says `OnLog` is per output line and must be combined with `logoutput` ([`[Run]` section](https://jrsoftware.org/ishelp/topic_runsection.htm), [support functions](https://jrsoftware.org/ishelp/topic_scriptfunctions.htm)).

### FitGirl implication

FitGirl’s own FAQ says it uses mostly FreeArc for compression and Inno Setup as the installer ([FitGirl FAQ](https://fitgirl-repacks.site/faq/)). The relevant extraction is therefore an external/custom FreeArc path rather than normal Inno `[Files]` extraction (this exact script layout is not published by FitGirl and is **unverified** for every repack). Inno can log the `[Run]` launch and, after the child returns, its result; it cannot infer a child’s internal decompression progress merely because `/LOG` is enabled.

**Conclusion:** expect the log to contain setup lifecycle lines and a launch record, then no extraction-progress lines while unarc runs unless that customized script explicitly calls `Log` or uses `logoutput`. It may show a post-extraction/verification message if the custom script emits one. Do not use log file length as the main progress denominator.

## 2. unarc/FreeArc behavior

### Verified facts

The FreeArc DLL interface is a callback-based API: `FreeArcExtract` accepts a callback, and the DLL’s timer thread generates `timer` events roughly every 10 ms while the decompression thread performs the command ([`unarcdll.h`](https://github.com/svn2github/freearc/blob/master/Unarc/unarcdll.h), [`unarcdll.cpp`](https://github.com/svn2github/freearc/blob/master/Unarc/unarcdll.cpp)). The extraction engine invokes UI progress callbacks for the current file, compressed input position (`read`), and written output (`write`) ([`ArcProcess.h`](https://github.com/svn2github/freearc/blob/master/Unarc/ArcProcess.h)).

The stock console UI prints archive/file messages with `printf` ([`CUI.h`](https://github.com/svn2github/freearc/blob/master/Unarc/CUI.h)). The DLL UI does not print those messages; it forwards callback events to the caller ([`unarcdll.cpp`](https://github.com/svn2github/freearc/blob/master/Unarc/unarcdll.cpp)). The FreeArc Inno example explicitly wraps that callback and updates an Inno progress gauge, demonstrating that machine-usable progress is available only when the host integrates the DLL callback ([example script](https://github.com/svn2github/freearc/blob/master/Unarc/InnoSetup/FreeArc_Example-Ext.iss)).

The extractor writes output through an output-file abstraction as decompressed blocks arrive ([`ArcProcess.h`](https://github.com/svn2github/freearc/blob/master/Unarc/ArcProcess.h)). It also has a `tempfile` compression-chain stage for memory management; that is an internal decompression workspace, not evidence that final game files are staged and atomically renamed ([same source](https://github.com/svn2github/freearc/blob/master/Unarc/ArcProcess.h)).

### What is not established

The sources reviewed do not establish that the particular `unarc.dll` embedded in a given FitGirl setup writes a progress log, temp progress file, named pipe, or stdout stream visible to the addon. They also do not establish a universal “write to temp then rename” policy for every archive/compressor combination. **Unverified:** inspect one real setup’s process tree and open files, or run a controlled repack under `strace`/Wine debugging, before relying on either behavior.

## 3. Expected final size

### FitGirl page semantics

FitGirl pages separate “Original Size” from “HDD space after installation.” For example, the Cyberpunk 2077 page lists Original Size 152.8 GB and HDD space after installation up to 152.8 GB ([page](https://fitgirl-repacks.site/cyberpunk-2077/)). The Elden Ring page lists Original Size 66.4 GB but HDD space after installation up to 69.6 GB ([page](https://fitgirl-repacks.site/elden-ring/)); Baldur’s Gate 3 lists Original Size 129.4 GB but HDD space after installation up to 156.4 GB ([page](https://fitgirl-repacks.site/baldurs-gate-3/)).

**Verified interpretation:** “Original Size” is the original game/distribution size shown by the repack page, while the separately labeled HDD figure is the page’s explicit post-install disk-space requirement. The examples prove Original Size is not always an exact final installed-directory size. **Inference:** use HDD space after installation as the denominator where present; use Original Size as a better-than-2× compressed-payload fallback, with a margin for temporary files, optional components, patches, and filesystem accounting.

### Repository state

`GameInfo` in [`src/fitgirl-metadata.ts`](../src/fitgirl-metadata.ts) has no size, Original Size, or HDD-space field, and `parseGameMetadataHtml` only extracts company, cover, torrent/direct links, and IDs. The current estimate in [`src/main.ts`](../src/main.ts) sums selected bin sizes and multiplies by two, with a 1 GiB floor. The tracker then divides directory bytes by that estimate and caps at 99 ([`src/main.ts`](../src/main.ts), [`src/install-progress.ts`](../src/install-progress.ts)).

## 4. Terminal phase: CRC verification and redists

Inno’s normal `[Run]` entries execute after the installation has succeeded and Setup waits for them by default ([`[Run]` documentation](https://jrsoftware.org/ishelp/topic_runsection.htm)). Inno’s own archive/file path logs successful archive extraction and verification-related events for features it owns ([`Setup.Install.pas`](https://github.com/jrsoftware/issrc/blob/main/Projects/Src/Setup.Install.pas)); that does not prove what a FitGirl custom CRC script logs.

FitGirl’s FAQ verifies the FreeArc/Inno toolchain, but the FAQ does not specify the custom installer’s CRC implementation or its progress protocol ([FAQ](https://fitgirl-repacks.site/faq/)). **Unverified for a particular repack:** whether CRC runs in unarc, a custom DLL, or another child; whether it reads the final files without changing them; and whether it writes a status line.

**Likely behavior (inference):** CRC verification reads already-created files, so the install directory’s byte total is flat while verification consumes CPU and disk reads. Optional redist installers can similarly leave the game directory flat; this addon deselects redists according to its automated setup configuration ([`src/main.ts`](../src/main.ts)). A flat directory is therefore not proof of a hung process.

The honest UI model is phase-based: use extraction progress while a bounded signal advances; after extraction reaches its end or directory growth becomes flat, switch to “Verifying installation…” with an indeterminate animation or a deliberately non-precise high-but-not-99 percentage; set 100 only after the setup process exits with success. A CRC-start line from `/LOG` may be used when observed, but must not be required.

## 5. Alternative signals and wrapper practice

### Official Inno interfaces

The reviewed official command-line help documents silent modes and logging, not a registry value, named pipe, or external progress API ([command-line parameters](https://jrsoftware.org/ishelp/topic_setupcmdline.htm)). The source’s external-child output path is opt-in through `[Run]`’s `logoutput` flag and is line-oriented, not a generic decompression-progress protocol ([Run source](https://github.com/jrsoftware/issrc/blob/main/Projects/Src/Setup.MainFunc.pas), [Run docs](https://jrsoftware.org/ishelp/topic_runsection.htm)). The `CurInstallProgressChanged` callback is an internal Pascal-script event for the installer UI, not an external observer channel ([event documentation](https://jrsoftware.org/ishelp/topic_scriptevents.htm)). No supported registry/window-message/named-pipe signal was found in these primary sources.

### Existing wrappers

The official Lutris source/scripts generally invoke Inno through Wine with `/SILENT` or `/VERYSILENT` and model the installer as a blocking task; its documented installer task has a description but no Inno extraction-progress adapter ([Lutris installer docs](https://github.com/lutris/lutris/blob/master/docs/installers.rst)). Chocolatey’s official helper is concerned with selecting silent arguments for executable installers, not extracting a progress stream ([Chocolatey helper](https://github.com/chocolatey/choco/blob/develop/src/chocolatey.resources/helpers/functions/Install-ChocolateyPackage.ps1)). Playnite’s official setup tests launch `/SILENT` and wait for the process, then assert installed files/registry state ([Playnite setup tests](https://github.com/JosefNemec/Playnite/blob/master/tests/Setup/Setup.Tests.ps1)). The WinGet manifest for an ordinary Inno installer advertises `silentWithProgress` as an install mode, but that is metadata about the installer’s supported mode, not evidence of a wrapper-readable progress API ([manifest example](https://github.com/microsoft/winget-pkgs/blob/master/manifests/p/Playnite/Playnite/10.7/Playnite.Playnite.installer.yaml)).

### `/proc/<pid>/fdinfo/<fd>` experiment

The kernel documentation says `/proc/<pid>/fdinfo/<fd>` for regular files includes `pos`, `flags`, `mnt_id`, and `ino`; `pos` is the current decimal offset of the opened file, with `lseek(2)` semantics ([kernel proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html#proc-pid-fdinfo-fd-information-about-opened-file)). This makes the proposed signal attractive:

1. Identify the Wine process tree rooted at the setup launch.
2. Enumerate each process’s `/proc/<pid>/fd` symlinks and retain descriptors resolving to the selected `fg-*.bin` files.
3. Read matching fdinfo `pos` values every few seconds.
4. Deduplicate by `(pid, fd, inode)` or, preferably, track each descriptor’s monotonic maximum and sum only the active archive reads.
5. Divide consumed compressed bytes by the total byte size of the selected bin files. Clamp to a conservative extraction-phase ceiling, then hand off to verification state.

This is **promising but experimental**, not a verified FitGirl contract. Risks are multiple opens of the same bin, concurrent descriptors, descriptor reuse, Wine server/helper processes outside a naive child walk, reads performed through `mmap` or buffered I/O that do not advance the file offset as expected, archive seeks (so `pos` can be non-monotonic), and FreeArc reading metadata or blocks out of order. The `pos` value is an offset for that open file description, not a guaranteed “bytes decompressed” counter. Validate on representative repacks before making it primary.

## Concrete recommendation

1. Extend scraped metadata with two optional byte values: `originalSize` and `hddSpaceAfterInstall`. Parse the page labels independently; do not infer one from the other. Prefer `hddSpaceAfterInstall` as the expected final directory-size denominator, then `originalSize`, then a conservative fallback based on selected payload size. Preserve optional-component selection in the denominator.
2. Replace the hard 2× estimate with a denominator selected by confidence. Keep the current directory-size tracker as a corroborating signal, but do not let it reach a misleading 99 early merely because the denominator is a heuristic.
3. Add an fdinfo sampler behind a feature flag/experiment. Treat compressed read position as an extraction-progress signal only when it passes sanity checks: matching inode/path, bounded by total selected bin bytes, enough samples advance, no sustained backward jumps, and a valid Wine process-tree match. Fall back to directory growth if checks fail.
4. Use an explicit state machine: `extracting` (directory/fdinfo progress), `verifying` (flat or indeterminate, with elapsed time), and `complete` (only successful process exit). Never report 100 from a byte estimate.
5. Log diagnostics for the experiment: selected bin total, candidate pids/fds/inodes, sampled positions, rejected candidates, and phase transitions. Do not parse `/LOG` as a stable schema; use it only for optional lifecycle hints and postmortem debugging.

## Unresolved risks / assumptions

- FitGirl’s FAQ and public repack pages were reachable and verified. The exact customized `setup.exe` script, unarc build, CRC implementation, and per-repack `[Run]` entries were not available from an authoritative FitGirl source; those details remain unverified.
- The mirrored FreeArc source is the primary source available for the historical FreeArc/unarc implementation, but it is a GitHub mirror rather than a current upstream release site ([mirror repository](https://github.com/svn2github/freearc)). Validate behavior against the binary actually shipped in the target repack.
- No source supports assuming that final files are always written directly, always temp-staged, or always renamed atomically.
- `/proc` is Linux-visible around Wine, but Wine may open Windows paths through helper processes or memory mappings. fdinfo should therefore ship as an observed-and-validated signal, not an unconditional promise.
