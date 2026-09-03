import { basename, dirname, join, relative } from "node:path";

/**
 * Finds a queued download folder at or above the setup directory. Add-on
 * downloads with relative paths are rooted at OGI's library directory, while
 * torrent setup paths can be nested several levels below it.
 */
export function resolveQueuedDownloadDirectory(
	setupDirectory: string,
	folderName: string,
	exists: (path: string) => boolean,
): string {
	let current = setupDirectory.replace(/[\\/]+$/, "") || setupDirectory;
	while (true) {
		const candidate = join(current, folderName);
		if (exists(candidate)) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return join(dirname(setupDirectory), folderName);
}

/** Includes OGI's mirrored setup directory under an ancestor old_files folder. */
export function repackCleanupDirectories(
	setupDirectory: string,
	exists: (path: string) => boolean,
): string[] {
	const directories = [setupDirectory];
	let current = dirname(setupDirectory);
	while (true) {
		const oldFilesRoot = join(current, "old_files");
		if (exists(oldFilesRoot)) {
			const mirroredSetup = join(oldFilesRoot, relative(current, setupDirectory));
			if (exists(mirroredSetup)) directories.push(mirroredSetup);
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return directories;
}

export function gameDirectoryName(gameName: string): string {
	return (
		gameName
			.replace(/[\\/]+/g, "_")
			.replace(/[\0<>:"|?*]/g, "_")
			.trim() || "Game"
	);
}

export function defaultInstallDirectory(
	setupDirectory: string,
	gameName?: string,
): string {
	const normalized = setupDirectory.replaceAll("\\", "/");
	const torrentMarker = normalized.indexOf("/.torrent/");
	const setupRoot = torrentMarker === -1
		? setupDirectory
		: setupDirectory.slice(0, torrentMarker);
	if (!gameName) {
		return setupRoot;
	}

	const directoryName = gameDirectoryName(gameName);
	const trimmedSetupRoot = setupRoot.replace(/[\\/]+$/, "") || setupRoot;
	if (basename(trimmedSetupRoot).toLowerCase() === directoryName.toLowerCase()) {
		return trimmedSetupRoot;
	}

	return join(dirname(trimmedSetupRoot), directoryName);
}

export function sikarugirLauncher(homeDirectory: string): string {
	return join(
		homeDirectory,
		"Applications",
		"Sikarugir",
		"Steam.app",
		"Contents",
		"MacOS",
		"launcher",
	);
}

export function sikarugirWine(homeDirectory: string): string {
	return join(
		homeDirectory,
		"Applications",
		"Sikarugir",
		"Steam.app",
		"Contents",
		"SharedSupport",
		"wine",
		"bin",
		"wine",
	);
}

export function sikarugirPrefix(homeDirectory: string): string {
	return join(
		homeDirectory,
		"Applications",
		"Sikarugir",
		"Steam.app",
		"Contents",
		"SharedSupport",
		"prefix",
	);
}

export function sikarugirFrameworks(homeDirectory: string): string {
	return join(
		homeDirectory,
		"Applications",
		"Sikarugir",
		"Steam.app",
		"Contents",
		"Frameworks",
	);
}
