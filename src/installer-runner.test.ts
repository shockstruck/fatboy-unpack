import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildInstallerLaunchPlan,
	convertUmuIdToGameId,
	dismissBlockingCompanions,
	killWinePrefixProcesses,
	removeFitgirlHostsEntries,
	toWinePath,
} from "./installer-runner";

const target = {
	installerExe: "/staging/update-1/1348 Ex Voto update 1.05.exe",
	installDir: "/mnt/games/Ex Voto",
	logFile: "/staging/update-1/installer.log",
};

describe("installer runner", () => {
	test("converts umu ids to GAMEID values", () => {
		expect(convertUmuIdToGameId("steam:12345")).toBe("umu-12345");
		expect(convertUmuIdToGameId("umu:my-game")).toBe("umu-my-game");
	});

	test("converts absolute Linux paths to Wine Z: paths", () => {
		expect(toWinePath("/mnt/games/Ex Voto")).toBe("Z:\\mnt\\games\\Ex Voto");
	});

	test("builds a native Windows plan with cwd beside the companion bin", () => {
		const plan = buildInstallerLaunchPlan(target, {
			platform: "win32",
			baseEnv: { PATH: "C:\\Windows" },
		});

		expect(plan.command).toBe(target.installerExe);
		expect(plan.cwd).toBe("/staging/update-1");
		expect(plan.args).toContain("/VERYSILENT");
		expect(plan.args).toContain(`/DIR=${target.installDir}`);
	});

	test("keeps Inno's progress window for compatibility-sensitive updaters", () => {
		const plan = buildInstallerLaunchPlan(
			{ ...target, showProgressWindow: true },
			{ platform: "win32", baseEnv: {} },
		);
		expect(plan.args).toContain("/SILENT");
		expect(plan.args).not.toContain("/VERYSILENT");
	});

	test("leaves custom RUNE installer controls available for automation", () => {
		const plan = buildInstallerLaunchPlan(
			{ ...target, interactive: true },
			{ platform: "win32", baseEnv: {} },
		);
		expect(plan.args).not.toContain("/SILENT");
		expect(plan.args).not.toContain("/VERYSILENT");
		expect(plan.args).not.toContain("/SUPPRESSMSGBOXES");
	});

	test("builds a UMU plan with per-game prefix and Wine paths", () => {
		const plan = buildInstallerLaunchPlan(target, {
			platform: "linux",
			baseEnv: { PATH: "/usr/bin" },
			umu: {
				umuRunPath: "/opt/ogi/bin/umu/umu-run",
				gameId: "umu-12345",
				winePrefix: "/home/user/.ogi-wine-prefixes/umu-12345",
			},
		});

		expect(plan.command).toBe("/opt/ogi/bin/umu/umu-run");
		expect(plan.args[0]).toBe(target.installerExe);
		expect(plan.args).toContain("/DIR=Z:\\mnt\\games\\Ex Voto");
		expect(plan.args).toContain("/LOG=Z:\\staging\\update-1\\installer.log");
		expect(plan.env.WINEPREFIX).toBe("/home/user/.ogi-wine-prefixes/umu-12345");
		expect(plan.env.GAMEID).toBe("umu-12345");
		expect(plan.env.PROTON_VERB).toBe("waitforexitandrun");
		// Each /DIR and /LOG value must stay one argv entry despite spaces.
		expect(plan.args.every((arg) => typeof arg === "string")).toBe(true);
	});

	test("refuses a non-Windows plan without UMU context", () => {
		expect(() =>
			buildInstallerLaunchPlan(target, { platform: "linux" }),
		).toThrow("UMU context");
	});

	test("omits component/task switches for updaters", () => {
		const plan = buildInstallerLaunchPlan(target, {
			platform: "win32",
			baseEnv: {},
		});
		expect(plan.args.some((arg) => arg.startsWith("/COMPONENTS"))).toBe(false);
		expect(plan.args.some((arg) => arg.startsWith("/TASKS"))).toBe(false);
	});

	test("selects components and deselects all tasks for initial installs", () => {
		const plan = buildInstallerLaunchPlan(
			{ ...target, components: ["text", "bonus"], tasks: [] },
			{ platform: "win32", baseEnv: {} },
		);
		expect(plan.args).toContain("/COMPONENTS=text,bonus");
		expect(plan.args).toContain("/TASKS=");
	});

	test("scrubs fitgirl hosts entries from a proton prefix", () => {
		const prefix = fs.mkdtempSync(join(tmpdir(), "fatboy-hosts-"));
		const etcDir = join(
			prefix,
			"pfx",
			"drive_c",
			"windows",
			"system32",
			"drivers",
			"etc",
		);
		fs.mkdirSync(etcDir, { recursive: true });
		const hostsPath = join(etcDir, "hosts");
		fs.writeFileSync(
			hostsPath,
			"127.0.0.1 localhost\n0.0.0.0 fitgirl-repacks.com\n0.0.0.0 fitgirl-repack.site\n",
		);
		try {
			expect(removeFitgirlHostsEntries({ winePrefix: prefix })).toBe(true);
			expect(fs.readFileSync(hostsPath, "utf-8")).toBe(
				"127.0.0.1 localhost\n",
			);
			// Idempotent: nothing left to remove on a second pass.
			expect(removeFitgirlHostsEntries({ winePrefix: prefix })).toBe(false);
		} finally {
			fs.rmSync(prefix, { recursive: true, force: true });
		}
	});

	test("kills processes carrying the wine prefix in their environment", async () => {
		// A unique fake prefix path in the child's env stands in for a real
		// Wine session; the sweep matches on env, not process names.
		const fakePrefix = join(tmpdir(), `fatboy-kill-${process.pid}`);
		const child = spawn("sleep", ["30"], {
			env: { ...process.env, WINEPREFIX: fakePrefix },
			stdio: "ignore",
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const killed = await killWinePrefixProcesses(fakePrefix, {
				graceMs: 200,
			});
			expect(killed).toBeGreaterThanOrEqual(1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("dismisses a QuickSFV verifier without killing unrelated prefix processes", async () => {
		const fakePrefix = join(tmpdir(), `fatboy-verifier-${process.pid}`);
		const verifier = spawn(
			"bash",
			["-c", "exec -a QuickSFV.exe sleep 30"],
			{
				env: { ...process.env, WINEPREFIX: fakePrefix },
				stdio: "ignore",
			},
		);
		const unrelated = spawn("sleep", ["30"], {
			env: { ...process.env, WINEPREFIX: fakePrefix },
			stdio: "ignore",
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(dismissBlockingCompanions(fakePrefix)).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(verifier.exitCode !== null || verifier.signalCode !== null).toBe(true);
			expect(unrelated.exitCode).toBeNull();
		} finally {
			verifier.kill("SIGKILL");
			unrelated.kill("SIGKILL");
		}
	});
});
