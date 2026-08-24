import { describe, expect, test } from "bun:test";
import {
	buildInstallerLaunchPlan,
	convertUmuIdToGameId,
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
});
