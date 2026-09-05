import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";

// Runs Inno Setup installers — FitGirl initial setups and the ElAmigos/FitGirl
// update family — natively on Windows or through OGI's bundled umu-run on
// Linux. Callers only describe the target; Inno switches, Z: path conversion,
// and Wine environment stay here.

export type InstallerTarget = {
	/** Absolute path to the installer exe. Companion .bin files must be siblings. */
	installerExe: string;
	/** Absolute path of the installation to write or patch. */
	installDir: string;
	/** Absolute path the installer writes its log to. */
	logFile: string;
	/**
	 * Component names to select; everything unlisted and non-fixed (DirectX,
	 * redists, soundtrack) is deselected. Inno ignores unknown names, so extra
	 * candidates are harmless. Omit for updaters, which define no components.
	 */
	components?: string[];
	/** Checkbox tasks to select; [] deselects them all (hosts file, icons). */
	tasks?: string[];
	/** Keep Inno's progress window for updater scripts that require its handle. */
	showProgressWindow?: boolean;
	/** Show a custom installer page that FatBoy or the user must drive. */
	interactive?: boolean;
};

export type UmuContext = {
	umuRunPath: string;
	/** GAMEID value, e.g. "umu-12345". Derive with convertUmuIdToGameId. */
	gameId: string;
	winePrefix: string;
	protonPath?: string;
};

export type InstallerLaunchPlan = {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
};

/** Converts an OGI umuId ("steam:123" | "umu:abc") to a GAMEID value ("umu-123"). */
export function convertUmuIdToGameId(umuId: string): string {
	if (umuId.startsWith("steam:")) {
		return `umu-${umuId.slice(6)}`;
	}
	if (umuId.startsWith("umu:")) {
		return `umu-${umuId.slice(4)}`;
	}
	return umuId;
}

/** Converts an absolute Linux path to the Wine view of it ("/a/b" → "Z:\a\b"). */
export function toWinePath(linuxPath: string): string {
	return `Z:${linuxPath.replaceAll("/", "\\")}`;
}

function buildInnoArgs(
	target: InstallerTarget,
	installDir: string,
	logFile: string,
): string[] {
	return [
		"/SP-",
		...(target.interactive
			? []
			: [target.showProgressWindow ? "/SILENT" : "/VERYSILENT"]),
		...(target.interactive ? [] : ["/SUPPRESSMSGBOXES"]),
		"/NORESTART",
		"/NOCLOSEAPPLICATIONS",
		"/NORESTARTAPPLICATIONS",
		"/LANG=english",
		`/DIR=${installDir}`,
		`/LOG=${logFile}`,
		...(target.components
			? [`/COMPONENTS=${target.components.join(",")}`]
			: []),
		...(target.tasks ? [`/TASKS=${target.tasks.join(",")}`] : []),
	];
}

type GameWindow = { id: string; pid: string };

function visibleGameWindows(gameId: string): GameWindow[] {
	if (process.platform !== "linux") return [];
	const appId = gameId.replace(/^umu-/, "");
	try {
		const ids = execFileSync(
			"xdotool",
			["search", "--onlyvisible", "--class", `steam_app_${appId}`],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		)
			.split(/\s+/)
			.filter(Boolean);
		return ids.flatMap((id) => {
			try {
				const pid = execFileSync("xdotool", ["getwindowpid", id], {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				return pid ? [{ id, pid }] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function gameWindowKey(window: GameWindow): string {
	return `${window.id}:${window.pid}`;
}

function windowDimensions(
	windowId: string,
): { width: number; height: number } | undefined {
	try {
		const geometry = execFileSync(
			"xdotool",
			["getwindowgeometry", "--shell", windowId],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		);
		const width = Number(geometry.match(/^WIDTH=(\d+)$/m)?.[1] ?? 0);
		const height = Number(geometry.match(/^HEIGHT=(\d+)$/m)?.[1] ?? 0);
		return { width, height };
	} catch {
		return undefined;
	}
}

/**
 * True once the RUNE updater's Inno log reports its install finished. RUNE runs
 * its patch inside a custom wizard page, then hands off to Inno's own [Files]
 * stage which logs these lines right before the Finished page appears — the
 * reliable signal that the Finish button is now present and enabled.
 */
function runeInstallFinished(logFile: string): boolean {
	try {
		return /Installation process succeeded|Need to restart Windows/i.test(
			fs.readFileSync(logFile, "utf-8"),
		);
	} catch {
		// The installer has not written its log yet; not finished.
		return false;
	}
}

export async function driveRuneInstaller(
	gameId: string,
	ignoredWindows: Set<string>,
	logFile: string,
	signal: AbortSignal,
): Promise<boolean> {
	if (process.platform !== "linux") return false;
	for (let attempt = 0; attempt < 120 && !signal.aborted; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const window = visibleGameWindows(gameId).find(
			(candidate) => {
				const dimensions = windowDimensions(candidate.id);
				return (
					!ignoredWindows.has(gameWindowKey(candidate)) &&
					Boolean(dimensions && dimensions.width > 100 && dimensions.height > 100)
				);
			},
		);
		if (!window) continue;
		const { id: windowId } = window;
		const initialDimensions = windowDimensions(windowId);
		if (!initialDimensions) continue;

		await new Promise((resolve) => setTimeout(resolve, 500));
		try {
			execFileSync("xdotool", ["windowactivate", "--sync", windowId], {
				stdio: "ignore",
			});
			execFileSync("xdotool", ["key", "--window", windowId, "alt+c"], {
				stdio: "ignore",
			});
			await new Promise((resolve) => setTimeout(resolve, 250));
			execFileSync("xdotool", ["key", "--window", windowId, "alt+i"], {
				stdio: "ignore",
			});
			// RUNE's Finish button has no reliable accelerator, and the wizard
			// window never resizes between pages, so we cannot detect the Finished
			// page from geometry. Instead wait until the Inno log reports the
			// install done, then activate the wizard's default button (Return) and
			// click its action-button slot each second until the window closes.
			// Both are inert while the button is disabled during patching.
			for (let finishAttempt = 0; finishAttempt < 1_800; finishAttempt += 1) {
				if (
					signal.aborted ||
					!visibleGameWindows(gameId).some(
						(candidate) => gameWindowKey(candidate) === gameWindowKey(window),
					)
				) {
					return true;
				}
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				if (!runeInstallFinished(logFile)) continue;
				const dimensions = windowDimensions(windowId);
				if (!dimensions) break;
				try {
					execFileSync("xdotool", ["key", "--window", windowId, "Return"], {
						stdio: "ignore",
					});
					execFileSync(
						"xdotool",
						[
							"mousemove",
							"--window",
							windowId,
							String(Math.round(dimensions.width * 0.73)),
							String(Math.round(dimensions.height * 0.51)),
							"click",
							"1",
						],
						{ stdio: "ignore" },
					);
				} catch {
					break;
				}
			}
			return false;
		} catch {
			// The window may have been replaced while Inno initialized; retry.
		}
	}
	return false;
}

export function snapshotGameWindows(gameId: string): Set<string> {
	return new Set(visibleGameWindows(gameId).map(gameWindowKey));
}

function buildUmuEnv(
	umu: UmuContext,
	baseEnv: Record<string, string | undefined>,
): Record<string, string> {
	return {
		...sanitizeEnv(baseEnv),
		GAMEID: umu.gameId,
		WINEPREFIX: umu.winePrefix,
		// umu-run defaults to this verb; keep it explicit so the process only
		// returns once the whole Wine descendant tree has exited.
		PROTON_VERB: "waitforexitandrun",
		...(umu.protonPath ? { PROTONPATH: umu.protonPath } : {}),
	};
}

/**
 * Disables the Wine audio driver in the install prefix. FitGirl setups play
 * music through their own audio code, not the Inno wizard; a very-silent run
 * never shows the wizard, and this makes the mute unconditional even if the
 * installer starts audio independently.
 */
export function buildMuteAudioPlan(
	umu: UmuContext,
	baseEnv?: Record<string, string | undefined>,
): InstallerLaunchPlan {
	return {
		command: umu.umuRunPath,
		args: [
			"reg",
			"add",
			"HKCU\\Software\\Wine\\Drivers",
			"/v",
			"Audio",
			"/t",
			"REG_SZ",
			"/d",
			"",
			"/f",
		],
		cwd: "/",
		env: buildUmuEnv(umu, baseEnv ?? (process.env as Record<string, string>)),
	};
}

/**
 * FitGirl's finish-page steps (fake-sites hosts entries, launch game, admin
 * rights) are postinstall [Run] entries, not [Tasks], so /TASKS= never reaches
 * them — and Inno executes checked-by-default postinstall entries even under
 * /VERYSILENT (issrc Setup.MainForm.pas: Finish -> ProcessPostInstallRunEntries
 * runs every RunList.Checked entry regardless of InstallMode; only skipifsilent
 * or unchecked entries escape). No CLI switch suppresses them, so we scrub the
 * hosts write afterwards. Under Wine it only ever lands in the prefix's hosts
 * file — never /etc/hosts — and Wine resolves names through the host libc, so
 * the entries are inert anyway; removing them just keeps the prefix clean.
 */
export function removeFitgirlHostsEntries(options: {
	/** Wine prefix the installer ran in; omit for native Windows installs. */
	winePrefix?: string;
}): boolean {
	const hostsSuffix = [
		"drive_c",
		"windows",
		"system32",
		"drivers",
		"etc",
		"hosts",
	];
	// Proton prefixes (umu) nest the Wine prefix under pfx/; Sikarugir and
	// plain Wine keep drive_c at the top. Native Windows writes the real file.
	const candidates = options.winePrefix
		? [
				join(options.winePrefix, "pfx", ...hostsSuffix),
				join(options.winePrefix, ...hostsSuffix),
			]
		: [
				join(
					process.env.SystemRoot ?? "C:\\Windows",
					"System32",
					"drivers",
					"etc",
					"hosts",
				),
			];
	let removedAny = false;
	for (const hostsPath of candidates) {
		let content: string;
		try {
			content = fs.readFileSync(hostsPath, "utf-8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		const kept = lines.filter((line) => !/fitgirl/i.test(line));
		if (kept.length !== lines.length) {
			fs.writeFileSync(hostsPath, kept.join("\n"));
			removedAny = true;
		}
	}
	return removedAny;
}

/**
 * Companion verification tools launched from postinstall [Run] entries that
 * open a GUI and wait for a human. Their sibling patch/install processes do
 * real work and must be left alone; only these viewers are safe to dismiss.
 */
const BLOCKING_COMPANIONS = /(?:rapidcrc|quicksfv)/i;

/**
 * Kills interactive companion windows of winePrefix so /VERYSILENT updater
 * runs cannot hang on "click Exit". Returns how many were dismissed.
 * Linux-only: reads /proc, like listWinePrefixPids.
 */
export function dismissBlockingCompanions(winePrefix: string): number {
	let dismissed = 0;
	for (const pid of listWinePrefixPids(winePrefix)) {
		let cmdline: string;
		try {
			cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
		} catch {
			continue;
		}
		if (BLOCKING_COMPANIONS.test(cmdline)) {
			try {
				process.kill(pid, "SIGKILL");
				dismissed += 1;
			} catch {
				// Already gone.
			}
		}
	}
	return dismissed;
}

/**
 * PIDs of live processes whose environment references winePrefix. FitGirl's
 * "launch the game" finish step is a nowait postinstall [Run] entry that also
 * fires under /VERYSILENT, so the game (plus wineserver/services.exe) can
 * outlive the installer. Every process in a Wine session carries the prefix
 * path in its environment, which is the most reliable handle we have on the
 * session from outside. Linux-only: reads /proc.
 */
export function listWinePrefixPids(winePrefix: string): number[] {
	const needle = winePrefix.endsWith("/") ? winePrefix.slice(0, -1) : winePrefix;
	const pids: number[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return pids;
	}
	for (const entry of entries) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
		try {
			const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf-8");
			if (environ.includes(needle)) pids.push(pid);
		} catch {
			// Exited mid-scan or not ours to read; either way not a target.
		}
	}
	return pids;
}

/**
 * Kills every Wine process still attached to winePrefix: SIGTERM, a grace
 * period, then SIGKILL for survivors. Returns how many processes were
 * signalled. On macOS /proc does not exist, so pass wineserverBin (sibling of
 * the wine binary) and the whole session is shut down via `wineserver -k`
 * instead.
 */
export async function killWinePrefixProcesses(
	winePrefix: string,
	options?: { wineserverBin?: string; graceMs?: number },
): Promise<number> {
	if (options?.wineserverBin) {
		try {
			execFileSync(options.wineserverBin, ["-k"], {
				env: { ...process.env, WINEPREFIX: winePrefix },
			});
			return 1;
		} catch {
			return 0;
		}
	}

	const signal = (pids: number[], sig: NodeJS.Signals): number[] =>
		pids.filter((pid) => {
			try {
				process.kill(pid, sig);
				return true;
			} catch {
				return false;
			}
		});

	const targets = signal(listWinePrefixPids(winePrefix), "SIGTERM");
	if (targets.length === 0) return 0;
	await new Promise((resolve) =>
		setTimeout(resolve, options?.graceMs ?? 2_000),
	);
	signal(listWinePrefixPids(winePrefix), "SIGKILL");
	return targets.length;
}

/**
 * Builds the exact process invocation for one updater run. The cwd is always
 * the installer's own directory so companion payloads (elamigos-1.bin) resolve.
 */
export function buildInstallerLaunchPlan(
	target: InstallerTarget,
	options: {
		platform: NodeJS.Platform;
		umu?: UmuContext;
		baseEnv?: Record<string, string | undefined>;
	},
): InstallerLaunchPlan {
	const baseEnv = options.baseEnv ?? (process.env as Record<string, string>);
	const cwd = dirname(target.installerExe);

	if (options.platform === "win32") {
		return {
			command: target.installerExe,
			args: buildInnoArgs(target, target.installDir, target.logFile),
			cwd,
			env: sanitizeEnv(baseEnv),
		};
	}

	const umu = options.umu;
	if (!umu) {
		throw new Error("UMU context is required to run installers off Windows");
	}

	return {
		command: umu.umuRunPath,
		args: [
			target.installerExe,
			...buildInnoArgs(
				target,
				toWinePath(target.installDir),
				toWinePath(target.logFile),
			),
		],
		cwd,
		env: buildUmuEnv(umu, baseEnv),
	};
}

function sanitizeEnv(
	env: Record<string, string | undefined>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

export type InstallerRunResult = {
	exitCode: number;
	output: string;
};

export type InstallerRun = (
	plan: InstallerLaunchPlan,
	onLog?: (line: string) => void,
) => Promise<InstallerRunResult>;

/** Runs a launch plan to completion. Never interprets a shell string. */
export const runInstaller: InstallerRun = (plan, onLog) => {
	return new Promise<InstallerRunResult>((resolve, reject) => {
		const child = spawn(plan.command, plan.args, {
			cwd: plan.cwd,
			env: plan.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const collect = (data: Buffer): void => {
			const text = data.toString();
			output = (output + text).slice(-16_384);
			onLog?.(text);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", reject);
		child.once("close", (code) => {
			resolve({ exitCode: code ?? -1, output });
		});
	});
};
