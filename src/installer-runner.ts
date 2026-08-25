import { spawn } from "node:child_process";
import { dirname } from "node:path";

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
		"/VERYSILENT",
		"/SUPPRESSMSGBOXES",
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
