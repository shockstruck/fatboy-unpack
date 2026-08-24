import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";

// Applies an update chain to a shadow copy of the installation, never the live
// game. The journal beside the install dir makes restart/power-loss recovery
// idempotent, and commit is two same-filesystem renames with the previous
// installation retained until the updated game launches successfully.

export type UpdateTransactionPhase =
	| "shadowing"
	| "patching"
	| "committing"
	| "committed";

type Journal = {
	phase: UpdateTransactionPhase;
	installDir: string;
	shadowDir: string;
	backupDir: string;
	targetVersion: string;
};

export type UpdateStep = {
	/** Label used in logs and validation errors, e.g. "v1.05". */
	label: string;
	/** Runs this step's installer against `targetDir`. Resolves the installer exit code. */
	run: (targetDir: string) => Promise<number>;
};

export type UpdateTransactionOptions = {
	installDir: string;
	/** Relative or absolute path of the game executable that must survive the update. */
	launchExecutable: string;
	targetVersion: string;
	steps: UpdateStep[];
	log: (message: string) => void;
};

export function shadowDirFor(installDir: string): string {
	return join(dirname(installDir), `.${basename(installDir)}.fatboy-shadow`);
}

export function backupDirFor(installDir: string): string {
	return join(dirname(installDir), `.${basename(installDir)}.fatboy-backup`);
}

function journalPathFor(installDir: string): string {
	return join(dirname(installDir), `.${basename(installDir)}.fatboy-journal`);
}

function writeJournal(journal: Journal): void {
	const path = journalPathFor(journal.installDir);
	const fd = fs.openSync(path, "w");
	try {
		fs.writeSync(fd, JSON.stringify(journal, null, 2));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function readJournal(installDir: string): Journal | undefined {
	const path = journalPathFor(installDir);
	if (!fs.existsSync(path)) {
		return undefined;
	}
	try {
		return JSON.parse(fs.readFileSync(path, "utf-8")) as Journal;
	} catch {
		return undefined;
	}
}

function clearJournal(installDir: string): void {
	fs.rmSync(journalPathFor(installDir), { force: true });
}

function directorySize(dir: string): number {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			total += directorySize(fullPath);
		} else if (entry.isFile()) {
			total += fs.statSync(fullPath).size;
		}
	}
	return total;
}

/**
 * Copies the installation into the shadow directory. Prefers reflinks so
 * CoW filesystems (btrfs/xfs) pay no space; a full copy checks free space
 * first and refuses rather than filling the disk.
 */
function createShadowCopy(installDir: string, shadowDir: string): void {
	fs.rmSync(shadowDir, { recursive: true, force: true });

	if (process.platform !== "win32") {
		const reflink = spawnSync(
			"cp",
			["-a", "--reflink=always", installDir, shadowDir],
			{ stdio: "ignore" },
		);
		if (reflink.status === 0) {
			return;
		}
		fs.rmSync(shadowDir, { recursive: true, force: true });
	}

	const needed = directorySize(installDir);
	const stats = fs.statfsSync(dirname(installDir));
	const available = stats.bavail * stats.bsize;
	// Updates also grow the copy while patching; require headroom.
	if (available < needed * 1.2) {
		throw new Error(
			`Not enough free space for a safe shadow copy: need about ${Math.ceil(
				(needed * 1.2) / 1024 / 1024,
			)} MiB, have ${Math.floor(available / 1024 / 1024)} MiB. ` +
				"Refusing to patch the live installation.",
		);
	}
	fs.cpSync(installDir, shadowDir, { recursive: true });
}

function validateShadow(shadowDir: string, launchExecutable: string): void {
	const executablePath = join(shadowDir, basename(launchExecutable));
	const executableSurvived =
		fs.existsSync(executablePath) ||
		fs.existsSync(join(shadowDir, launchExecutable));
	if (!executableSurvived) {
		throw new Error(
			`Validation failed: game executable ${basename(launchExecutable)} is missing after patching`,
		);
	}

	const leftovers: string[] = [];
	const scan = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				scan(fullPath);
			} else if (/\.(patch|tmp)$/i.test(entry.name)) {
				leftovers.push(fullPath);
			}
		}
	};
	scan(shadowDir);
	if (leftovers.length > 0) {
		throw new Error(
			`Validation failed: patching left temporary files behind (${leftovers
				.slice(0, 5)
				.map((file) => basename(file))
				.join(", ")})`,
		);
	}
}

/**
 * Applies every step to a shadow copy, validates, and commits with renames.
 * On any failure before commit the live installation is untouched. Returns the
 * backup directory retained for rollback until the next successful launch.
 */
export async function applyUpdateTransaction(
	options: UpdateTransactionOptions,
): Promise<{ backupDir: string }> {
	const { installDir, launchExecutable, targetVersion, steps, log } = options;
	const shadowDir = shadowDirFor(installDir);
	const backupDir = backupDirFor(installDir);
	const journal: Journal = {
		phase: "shadowing",
		installDir,
		shadowDir,
		backupDir,
		targetVersion,
	};

	if (fs.existsSync(backupDir)) {
		throw new Error(
			"A previous update backup still exists. Launch the game once to confirm the last update, then retry.",
		);
	}

	writeJournal(journal);
	log("Creating shadow copy of the installation...");
	createShadowCopy(installDir, shadowDir);

	try {
		journal.phase = "patching";
		writeJournal(journal);
		for (const step of steps) {
			log(`Applying update ${step.label}...`);
			const exitCode = await step.run(shadowDir);
			if (exitCode !== 0) {
				throw new Error(
					`Update ${step.label} installer exited with code ${exitCode}`,
				);
			}
		}

		log("Validating patched installation...");
		validateShadow(shadowDir, launchExecutable);
	} catch (error) {
		fs.rmSync(shadowDir, { recursive: true, force: true });
		clearJournal(installDir);
		throw error;
	}

	journal.phase = "committing";
	writeJournal(journal);
	log("Committing update...");
	fs.renameSync(installDir, backupDir);
	fs.renameSync(shadowDir, installDir);
	journal.phase = "committed";
	writeJournal(journal);
	clearJournal(installDir);

	return { backupDir };
}

/**
 * Makes an interrupted transaction safe again. Pre-commit crashes drop the
 * shadow; a crash between the two commit renames rolls the backup rename back.
 * Safe to call when no transaction was in flight.
 */
export function recoverUpdateTransaction(
	installDir: string,
	log: (message: string) => void,
): void {
	const journal = readJournal(installDir);
	const shadowDir = shadowDirFor(installDir);

	if (!journal) {
		if (fs.existsSync(shadowDir)) {
			log("Removing orphaned update shadow copy...");
			fs.rmSync(shadowDir, { recursive: true, force: true });
		}
		return;
	}

	if (journal.phase === "shadowing" || journal.phase === "patching") {
		log("Recovering from an interrupted update: discarding shadow copy.");
		fs.rmSync(journal.shadowDir, { recursive: true, force: true });
		clearJournal(installDir);
		return;
	}

	// committing/committed: roll forward if the shadow already replaced the
	// install dir, otherwise undo the half-finished rename pair.
	if (!fs.existsSync(installDir) && fs.existsSync(journal.shadowDir)) {
		log("Recovering from an interrupted commit: finishing rename.");
		fs.renameSync(journal.shadowDir, installDir);
	} else if (!fs.existsSync(installDir) && fs.existsSync(journal.backupDir)) {
		log("Recovering from an interrupted commit: restoring previous install.");
		fs.renameSync(journal.backupDir, installDir);
	}
	clearJournal(installDir);
}

/** Removes the retained previous installation after the update proved itself. */
export function discardUpdateBackup(installDir: string): void {
	fs.rmSync(backupDirFor(installDir), { recursive: true, force: true });
}

/** Restores the retained previous installation, discarding the failed update. */
export function rollbackToBackup(installDir: string): void {
	const backupDir = backupDirFor(installDir);
	if (!fs.existsSync(backupDir)) {
		throw new Error("No update backup available to roll back to");
	}
	fs.rmSync(installDir, { recursive: true, force: true });
	fs.renameSync(backupDir, installDir);
}
