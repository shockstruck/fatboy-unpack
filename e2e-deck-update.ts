import crypto from "node:crypto";
import fs from "node:fs";
import { join, relative } from "node:path";
import type { UpdateLibraryInfo } from "./src/update-flow";
import { applyLocalUpdatePackages } from "./src/update-flow";
import {
	backupDirFor,
	recoverUpdateTransaction,
	rollbackToBackup,
	shadowDirFor,
} from "./src/update-transaction";

// One-off e2e driver for the Steam Deck: runs the real Palworld update chain
// through applyLocalUpdatePackages in safe mode, rolls back, then re-runs it
// with createBackup: false, asserting both modes converge on the same result.

const installDir =
	"/run/media/deck/Deck SD/OGI/Palworld/Palworld [FitGirl Repack]";
const packagesRoot =
	"/run/media/deck/Deck SD/OGI/Palworld/palworld-update-packages";
const shippingExe = join(
	installDir,
	"Pal",
	"Binaries",
	"Win64",
	"Palworld-Win64-Shipping.exe",
);
const targetVersion = "24575825";
const packages = ["update-0", "update-1", "update-2", "update-3"].map((d) =>
	join(packagesRoot, d),
);

const currentLibraryInfo: UpdateLibraryInfo = {
	appID: 1623730,
	cwd: join(installDir, "Pal", "Binaries", "Win64"),
	launchExecutable: shippingExe,
	umu: {
		umuId: "steam:1623730",
		winePrefixPath: "/home/deck/.ogi-wine-prefixes/umu-1623730",
	} as UpdateLibraryInfo["umu"],
};
const context = {
	platform: process.platform,
	umuRunPath:
		"/home/deck/.local/share/OpenGameInstaller/bin/umu/umu-run",
	homeDir: "/home/deck",
};

const log = (message: string): void =>
	console.log(`[${new Date().toISOString()}] ${message}`);

function progressLogger(phase: string): (progress: number) => void {
	let lastBucket = -1;
	return (progress) => {
		const bucket = Math.floor(progress / 5);
		if (bucket !== lastBucket || progress === 100) {
			lastBucket = bucket;
			log(`[${phase}] progress ${progress.toFixed(1)}%`);
		}
	};
}

function hashFile(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha1");
		fs.createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});
}

/** Sorted "relpath size" lines for every regular file under dir. */
function manifest(dir: string): string[] {
	const lines: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				lines.push(`${relative(dir, fullPath)} ${fs.statSync(fullPath).size}`);
			}
		}
	};
	walk(dir);
	return lines.sort();
}

function assert(condition: boolean, label: string): void {
	if (!condition) {
		throw new Error(`ASSERTION FAILED: ${label}`);
	}
	log(`assert ok: ${label}`);
}

async function applyChain(createBackup: boolean, phase: string) {
	return applyLocalUpdatePackages({
		packages,
		installDir,
		targetVersion,
		currentLibraryInfo,
		context,
		log: (message) => log(`[${phase}] ${message}`),
		setProgress: progressLogger(phase),
		createBackup,
	});
}

try {
	const backupDir = backupDirFor(installDir);
	const shadowDir = shadowDirFor(installDir);

	log("=== PHASE A: safe-mode update (createBackup: true) ===");
	const originalHash = await hashFile(shippingExe);
	log(`original shipping exe sha1: ${originalHash}`);

	recoverUpdateTransaction(installDir, (message) => log(`[recover] ${message}`));
	assert(
		!fs.existsSync(join(installDir, "..", ".Palworld [FitGirl Repack].fatboy-journal")),
		"stale journal cleared by recovery",
	);

	const safeResult = await applyChain(true, "phase-a");
	assert(safeResult.backupDir === backupDir, "safe mode returned the backup dir");
	assert(fs.existsSync(backupDir), "backup dir exists after safe-mode commit");
	assert(!fs.existsSync(shadowDir), "no shadow dir left after commit");
	assert(fs.existsSync(shippingExe), "shipping exe present after safe update");

	const updatedHash = await hashFile(shippingExe);
	log(`updated shipping exe sha1: ${updatedHash}`);
	assert(updatedHash !== originalHash, "safe update changed the shipping exe");
	const backupHash = await hashFile(
		join(backupDir, "Pal", "Binaries", "Win64", "Palworld-Win64-Shipping.exe"),
	);
	assert(backupHash === originalHash, "backup retained the original build");

	log("capturing post-update manifest...");
	const manifestA = manifest(installDir);
	fs.writeFileSync("/tmp/e2e-manifest-a.txt", manifestA.join("\n"));
	log(`manifest A: ${manifestA.length} files`);

	log("=== PHASE B: rollback to backup ===");
	rollbackToBackup(installDir);
	assert(!fs.existsSync(backupDir), "backup consumed by rollback");
	const rolledBackHash = await hashFile(shippingExe);
	assert(rolledBackHash === originalHash, "rollback restored the original build");

	log("=== PHASE C: direct update (createBackup: false) ===");
	const directResult = await applyChain(false, "phase-c");
	assert(directResult.backupDir === undefined, "direct mode returned no backup dir");
	assert(!fs.existsSync(backupDir), "direct mode created no backup dir");
	assert(!fs.existsSync(shadowDir), "direct mode created no shadow dir");

	const directHash = await hashFile(shippingExe);
	assert(directHash === updatedHash, "direct mode produced the same shipping exe");

	const manifestC = manifest(installDir);
	fs.writeFileSync("/tmp/e2e-manifest-c.txt", manifestC.join("\n"));
	const setA = new Set(manifestA);
	const onlyA = manifestA.filter((line) => !manifestC.includes(line));
	const onlyC = manifestC.filter((line) => !setA.has(line));
	log(`manifest C: ${manifestC.length} files; onlyA=${onlyA.length} onlyC=${onlyC.length}`);
	for (const line of onlyA.slice(0, 10)) log(`  only in safe-mode result: ${line}`);
	for (const line of onlyC.slice(0, 10)) log(`  only in direct result: ${line}`);
	assert(
		onlyA.length === 0 && onlyC.length === 0,
		"safe and direct modes produced identical file manifests",
	);

	// Leave the store record the way runUpdateSetup would after a direct update.
	const recordPath = "./installed-repacks/1623730.json";
	const record = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
	record.installedVersion = targetVersion;
	record.pendingUpdateVersion = undefined;
	record.pendingBackupDir = undefined;
	record.appliedUpdates = [
		...(record.appliedUpdates ?? []),
		{ version: targetVersion, packages, appliedAt: new Date().toISOString() },
	];
	fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
	log("installed-repacks record updated to the target version");

	log("E2E RESULT: PASS");
} catch (error) {
	log(`E2E RESULT: FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
}
