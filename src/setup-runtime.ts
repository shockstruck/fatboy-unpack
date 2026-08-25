import { join } from "node:path";

export function defaultInstallDirectory(setupDirectory: string): string {
	const normalized = setupDirectory.replaceAll("\\", "/");
	const torrentMarker = normalized.indexOf("/.torrent/");
	return torrentMarker === -1
		? setupDirectory
		: setupDirectory.slice(0, torrentMarker);
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
