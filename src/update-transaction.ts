import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

// Applies an update chain to a rollback-capable shadow copy by default, or to
// the live installation when the user explicitly disables backups. The journal
// makes the safe mode restart/power-loss recovery idempotent.

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
	/**
	 * Applies this step against `targetDir`. Resolves its exit code. May report
	 * its own progress as a 0..1 fraction of the step through `onStepProgress`.
	 */
	run: (
		targetDir: string,
		onStepProgress?: (fraction: number) => void,
	) => Promise<number>;
};

export type UpdateTransactionOptions = {
	installDir: string;
	/** Relative or absolute path of the game executable that must survive the update. */
	launchExecutable: string;
	targetVersion: string;
	steps: UpdateStep[];
	log: (message: string) => void;
	setProgress?: (progress: number) => void;
	/** Disable to patch installDir directly without rollback protection. */
	createBackup?: boolean;
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
async function copyDirectoryWithProgress(
	sourceDir: string,
	targetDir: string,
	totalBytes: number,
	onProgress: (progress: number) => void,
): Promise<void> {
	let copiedBytes = 0;
	let lastReported = -1;
	let lastReportedAt = 0;
	const report = (force = false): void => {
		const progress = Math.min(
			(copiedBytes / Math.max(totalBytes, 1)) * 100,
			100,
		);
		const now = Date.now();
		if (!force && progress < lastReported + 0.1 && now - lastReportedAt < 250) {
			return;
		}
		lastReported = progress;
		lastReportedAt = now;
		onProgress(progress);
	};

	const copyEntry = async (source: string, target: string): Promise<void> => {
		const stat = await fs.promises.lstat(source);
		if (stat.isDirectory()) {
			await fs.promises.mkdir(target, { recursive: true, mode: stat.mode });
			for (const entry of await fs.promises.readdir(source)) {
				await copyEntry(join(source, entry), join(target, entry));
			}
			await fs.promises.chmod(target, stat.mode);
			await fs.promises.utimes(target, stat.atime, stat.mtime);
			return;
		}
		if (stat.isSymbolicLink()) {
			await fs.promises.symlink(await fs.promises.readlink(source), target);
			return;
		}
		if (!stat.isFile()) return;

		const read = fs.createReadStream(source, {
			highWaterMark: 4 * 1024 * 1024,
		});
		const write = fs.createWriteStream(target, { mode: stat.mode });
		read.on("data", (chunk: Buffer) => {
			copiedBytes += chunk.length;
			report();
		});
		await pipeline(read, write);
		await fs.promises.chmod(target, stat.mode);
		await fs.promises.utimes(target, stat.atime, stat.mtime);
	};

	await copyEntry(sourceDir, targetDir);
	copiedBytes = totalBytes;
	report(true);
}

async function createShadowCopy(
	installDir: string,
	shadowDir: string,
	onProgress: (progress: number) => void,
): Promise<void> {
	fs.rmSync(shadowDir, { recursive: true, force: true });
	onProgress(0);

	if (process.platform !== "win32") {
		const reflink = spawnSync(
			"cp",
			["-a", "--reflink=always", installDir, shadowDir],
			{ stdio: "ignore" },
		);
		if (reflink.status === 0) {
			onProgress(100);
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
	await copyDirectoryWithProgress(
		installDir,
		shadowDir,
		needed,
		onProgress,
	);
}

function validateInstallation(installDir: string, launchExecutable: string): void {
	const executablePath = join(installDir, basename(launchExecutable));
	const executableSurvived =
		fs.existsSync(executablePath) ||
		fs.existsSync(join(installDir, launchExecutable));
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
	scan(installDir);
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
 * Applies every step, validates, and returns the optional rollback backup.
 * Safe mode patches a shadow and commits with renames; direct mode modifies
 * the live installation and cannot roll back a partially applied update.
 */
export async function applyUpdateTransaction(
	options: UpdateTransactionOptions,
): Promise<{ backupDir?: string }> {
	const {
		installDir,
		launchExecutable,
		targetVersion,
		steps,
		log,
		setProgress,
		createBackup = true,
	} = options;
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
	// Progress within [base, base+span] for one step, from its 0..1 fraction.
	const stepProgress = (
		base: number,
		span: number,
		index: number,
		count: number,
	): ((fraction: number) => void) | undefined =>
		setProgress
			? (fraction) =>
					setProgress(
						base + ((index + Math.min(Math.max(fraction, 0), 1)) / count) * span,
					)
			: undefined;

	if (!createBackup) {
		log("Backup disabled; applying update directly to the installation...");
		setProgress?.(0);
		for (const [index, step] of steps.entries()) {
			setProgress?.((index / Math.max(steps.length, 1)) * 90);
			log(`Applying update ${step.label}...`);
			const exitCode = await step.run(
				installDir,
				stepProgress(0, 90, index, steps.length),
			);
			if (exitCode !== 0) {
				throw new Error(
					`Update ${step.label} installer exited with code ${exitCode}`,
				);
			}
			setProgress?.(((index + 1) / steps.length) * 90);
		}
		setProgress?.(95);
		log("Validating updated installation...");
		validateInstallation(installDir, launchExecutable);
		setProgress?.(100);
		return {};
	}

	writeJournal(journal);
	log("Creating shadow copy of the installation...");
	await createShadowCopy(installDir, shadowDir, (progress) =>
		setProgress?.(progress * 0.8),
	);

	try {
		journal.phase = "patching";
		writeJournal(journal);
		for (const [index, step] of steps.entries()) {
			setProgress?.(80 + (index / Math.max(steps.length, 1)) * 15);
			log(`Applying update ${step.label}...`);
			const exitCode = await step.run(
				shadowDir,
				stepProgress(80, 15, index, steps.length),
			);
			if (exitCode !== 0) {
				throw new Error(
					`Update ${step.label} installer exited with code ${exitCode}`,
				);
			}
			setProgress?.(80 + ((index + 1) / steps.length) * 15);
		}

		setProgress?.(97);
		log("Validating patched installation...");
		validateInstallation(shadowDir, launchExecutable);
	} catch (error) {
		fs.rmSync(shadowDir, { recursive: true, force: true });
		clearJournal(installDir);
		throw error;
	}

	journal.phase = "committing";
	writeJournal(journal);
	setProgress?.(99);
	log("Committing update...");
	fs.renameSync(installDir, backupDir);
	fs.renameSync(shadowDir, installDir);
	journal.phase = "committed";
	writeJournal(journal);
	clearJournal(installDir);
	setProgress?.(100);

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
