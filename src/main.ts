import { execFileSync, execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { JSDOM } from "jsdom";
import OGIAddon, {
	ConfigurationBuilder,
	type EventListenerTypes,
	SearchTool,
} from "ogi-addon";
import { solveDDOSGuard } from "./ddosguard";
import {
	resolveFuckingFastFiles,
	resolveFuckingFastUpdateFiles,
} from "./direct-download";
import { catchDownload, renderFileCryptContainer } from "./download";
import {
	type ExtractionJob,
	extractAllWithProgress,
	parseSevenZipProgress,
	parseUnrarProgress,
} from "./extraction-progress";
import {
	requestFileCryptResource,
	unlockFileCryptContainer,
} from "./filecrypt";
import { type GameInfo, parseGameMetadataHtml } from "./fitgirl-metadata";
import {
	type DownloadedUpdateGroup,
	FITGIRL_UPDATES_URL,
	type FitGirlUpdate,
	inferUpdateTargetVersion,
	parseFitGirlUpdates,
	resolveDownloadedUpdatePackages,
} from "./fitgirl-updates";
import { resolveServiceFromUrl } from "./matcher";
import {
	extractRepackVersion,
	listInstalledRepacks,
	loadInstalledRepack,
	saveInstalledRepack,
} from "./repack-store";
import {
	axiosGetWithDDOSGuard,
	scrapeHer,
	shouldScrape,
	updateCookieString,
} from "./scraper";
import { findBestGameMatch, type Game } from "./string-similarity";
import {
	defaultInstallDirectory,
	sikarugirFrameworks,
	sikarugirLauncher,
	sikarugirPrefix,
	sikarugirWine,
} from "./setup-runtime";
import {
	buildInstallerLaunchPlan,
	buildMuteAudioPlan,
	runInstaller,
	toWinePath,
	type UmuContext,
} from "./installer-runner";
import { applyLocalUpdatePackages, installDirOf } from "./update-flow";
import {
	discardUpdateBackup,
	recoverUpdateTransaction,
} from "./update-transaction";
import {
	excludeOptionalBins,
	sniffRepackBins,
	type OptionalBinGroup,
	type RepackBins,
} from "./repack-bins";
import { trackInstallProgress } from "./install-progress";

const UMU_BIN = join(
	process.env.HOME! ?? "",
	".local",
	"share",
	"OpenGameInstaller",
	"bin",
	"umu",
	"umu-run",
);
// Cookie string is now managed in scraper.ts
const addon = new OGIAddon({
	author: "Fat-Addons",
	description: "A FitGirl Repack scraper.",
	name: "Fatboy Unpack",
	id: "fatboy-unpack",
	repository: "https://github.com/Fat-Addons/fatboy-unpack",
	version: "1.0.0",
	storefronts: ["steam"],
});

let scrapedGames: Game[] | undefined;
const pendingUpdateVersions = new Map<number, string>();
const makeSearch = () => {
	return new SearchTool<Game>([], ["name"], {
		threshold: 0.1,
		includeScore: true,
	});
};
let search = makeSearch();

addon.on("configure", (config) =>
	config
		.addStringOption((option) =>
			option
				.setName("whereToWine")
				.setDefaultValue("umu")
				.setDisplayName("Wine Source")
				.setDescription("Where to go to if wine is needed.")
				.setAllowedValues(["umu"]),
		)
		.addBooleanOption((option) =>
			option
				.setName("ignoreHypervisorOnLinux")
				.setDisplayName("Ignore HYPERVISOR Cracks on Linux")
				.setDescription(
					"Do not show FitGirl entries with HYPERVISOR in the title when running on Linux.",
				)
				.setDefaultValue(true),
		)
		.addActionOption((option) =>
			option
				.setName("re-run-scrapes")
				.setDisplayName("Re-run Scrapes")
				.setDescription("Re-run the scrapes for FitGirl Repacks")
				.setButtonText("Run")
				.setTaskName("re-run-scrapes"),
		),
);

addon.on("search", (data, event) => {
	const { appID, storefront, for: searchType } = data;
	if (data.for === "update") {
		const record = loadInstalledRepack(appID);
		event.defer(async () => {
			const targetVersion =
				pendingUpdateVersions.get(appID) ??
				record?.pendingUpdateVersion ??
				(await addon.getAppDetails(appID, storefront))?.latestVersion ??
				"unknown";
			const results: Parameters<typeof event.resolve>[0] = [];
			try {
				const response = await axiosGetWithDDOSGuard(
					addon,
					FITGIRL_UPDATES_URL,
					{},
				);
				const updates = parseFitGirlUpdates(
					response.data,
					data.libraryInfo.name,
				);
				if (updates.length > 0) {
					results.push({
						name: `FileCrypt Update Packages | ${data.libraryInfo.name}`,
						downloadType: "request",
						manifest: {
							service: "filecrypt-update",
							updates,
							targetVersion:
								targetVersion === "unknown"
									? inferUpdateTargetVersion(updates.at(-1)?.name)
									: targetVersion,
						},
						clearOldFilesBeforeUpdate: false,
					});
				}
			} catch (error) {
				console.log(`Failed to load FitGirl update packages: ${error}`);
			}
			event.resolve(results);
		});
		return;
	}
	const noResolution: Parameters<typeof event.resolve>[0] = [
		{
			downloadType: "request",
			name: "Local Files",
			manifest: {
				service: "local",
			},
		},
	];
	if (searchType === "task") {
		event.defer();
		event.resolve(noResolution);
		return;
	}

	if (scrapedGames === undefined) {
		event.defer();
		addon.notify({
			message:
				"FatBoy: There are no scraped games available. Try restarting the addon server or wait for the scrape to complete.",
			id: "fatboy-unpack-scraping",
			type: "info",
		});
		event.resolve(noResolution);
		return;
	}

	event.defer(async () => {
		console.log("should be deferred");
		const noResolutionAndReset: Parameters<typeof event.resolve>[0] = [
			{
				downloadType: "request",
				name: "Local Files",
				manifest: {
					service: "local",
				},
			},
			{
				downloadType: "task",
				name: "Update Scrapes - Refresh FitGirl Repacks",
				taskName: "re-run-scrapes",
			},
		];
		const game = await addon.getAppDetails(appID, storefront);
		if (!game) {
			event.resolve(noResolutionAndReset);
			return;
		}
		// now get the game metadata from fitgirl
		const fitGame = findBestGameMatch(game.name, scrapedGames!, search, {
			ignoreHypervisor:
				process.platform === "linux" &&
				(addon.config.getBooleanValue("ignoreHypervisorOnLinux") ?? true),
		});

		if (!fitGame) {
			event.resolve(noResolutionAndReset);
			return;
		}

		const gameMetaData = await scrapeGameMetadata(
			fitGame,
			generateHash(game.name),
		);
		const results: Parameters<typeof event.resolve>[0] = noResolution;

		// direct service - FuckingFast
		console.log("direct services", gameMetaData.directLinks);
		const fuckingFastLinks =
			gameMetaData.directLinks?.find(
				(directLink) => directLink.service === "FuckingFast",
			)?.links ?? [];
		if (fuckingFastLinks.length > 0) {
			results.push({
				name: `FuckingFast | ${gameMetaData.name}`,
				downloadType: "request",
				manifest: {
					service: "FuckingFast",
					links: fuckingFastLinks.map((link) => ({
						name: link.name,
						url: link.url,
					})),
					// Exact repack identity, persisted at setup so update checks never
					// fuzzy-match installed games again.
					fitgirlUrl: fitGame.url,
					fitgirlRelease: fitGame.name,
					fitgirlGameName: game.name,
					originalSizeBytes: gameMetaData.originalSizeBytes,
					hddSpaceAfterInstallBytes: gameMetaData.hddSpaceAfterInstallBytes,
				},
			});
		}

		const fileCryptLinks = Array.from(
			new Map(
				gameMetaData.directLinks
					.flatMap((directLink) => directLink.links)
					.filter((link) => {
						try {
							return resolveServiceFromUrl(link.url).name === "FileCrypt";
						} catch {
							return false;
						}
					})
					.map((link) => [link.url, link]),
			).values(),
		);
		if (fileCryptLinks.length > 0) {
			results.push({
				name: `FileCrypt | ${gameMetaData.name}`,
				downloadType: "request",
				manifest: {
					service: "FileCrypt",
					links: fileCryptLinks,
					fitgirlUrl: fitGame.url,
					fitgirlRelease: fitGame.name,
					fitgirlGameName: game.name,
					originalSizeBytes: gameMetaData.originalSizeBytes,
					hddSpaceAfterInstallBytes: gameMetaData.hddSpaceAfterInstallBytes,
				},
			});
		}

		// magnet link - 1337x
		if (gameMetaData.magnetLink) {
			results.push({
				name: `1337x | ${gameMetaData.name}`,
				downloadType: "magnet",
				downloadURL: gameMetaData.magnetLink,
				filename: generateHash(game.name),
				manifest: {
					fitgirlUrl: fitGame.url,
					fitgirlRelease: fitGame.name,
					originalSizeBytes: gameMetaData.originalSizeBytes,
					hddSpaceAfterInstallBytes: gameMetaData.hddSpaceAfterInstallBytes,
				},
			});
		}
		event.resolve([
			// sort so that the local files entry (downloadType === 'request' && manifest.service === 'local) is always last, and others retain order.
			...results.filter(
				(r) => r.downloadType !== "request" || r.manifest?.service !== "local",
			),
			...results.filter(
				(r) => r.downloadType === "request" && r.manifest?.service === "local",
			),
		]);
	});
});

addon.on(
	"check-for-updates",
	({ appID, storefront, currentVersion }, event) => {
		event.defer(async () => {
			const record = loadInstalledRepack(appID);
			if (!record?.fitgirlUrl) {
				// Games installed by another source can still use Fatboy's local update
				// flow. The storefront build is the stable target OGI validates later.
				const latestVersion = (await addon.getAppDetails(appID, storefront))
					?.latestVersion;
				if (!latestVersion || latestVersion === currentVersion) {
					event.resolve({ available: false });
					return;
				}
				pendingUpdateVersions.set(appID, latestVersion);
				event.resolve({ available: true, version: latestVersion });
				return;
			}

			let latestVersion: string;
			try {
				const response = await axiosGetWithDDOSGuard(
					addon,
					record.fitgirlUrl,
					{},
				);
				const dom = new JSDOM(response.data);
				const title =
					dom.window.document.querySelector("h1.entry-title")?.textContent ??
					"";
				latestVersion = extractRepackVersion(title);
			} catch (err) {
				console.log(`check-for-updates: failed to fetch repack page: ${err}`);
				event.resolve({ available: false });
				return;
			}

			// Versions are opaque labels: only inequality against the installed
			// version signals an update, never any ordering of the strings.
			const installedVersion = record.installedVersion ?? currentVersion;
			if (latestVersion === "unknown" || latestVersion === installedVersion) {
				event.resolve({ available: false });
				return;
			}

			record.pendingUpdateVersion = latestVersion;
			saveInstalledRepack(record);
			pendingUpdateVersions.set(appID, latestVersion);
			event.resolve({ available: true, version: latestVersion });
		});
	},
);

addon.on("launch-app", ({ libraryInfo, launchType }, event) => {
	event.defer();
	// A retained pre-update backup is only discarded once the updated game
	// has actually launched.
	if (launchType === "post") {
		const record = loadInstalledRepack(libraryInfo.appID);
		if (record?.pendingBackupDir) {
			try {
				discardUpdateBackup(installDirOf(libraryInfo));
				record.pendingBackupDir = undefined;
				saveInstalledRepack(record);
				console.log(
					`Discarded update backup for ${libraryInfo.name} after successful launch`,
				);
			} catch (err) {
				console.log(`Failed to discard update backup: ${err}`);
			}
		}
	}
	event.complete();
});

function spawnAndHook(
	options: {
		stdout?: (data: string) => void;
		stderr?: (data: string) => void;
		onClose?: (code: number) => void;
		onError?: (err: Error) => void;
		rootPassword?: string;
		cwd?: string;
		env?: Record<string, string>;
	},
	command: Parameters<typeof spawn>[0],
	args: Parameters<typeof spawn>[1],
) {
	const spawnOptions = options.cwd
		? { cwd: options.cwd, env: options.env }
		: {};
	console.log(
		"running: " +
			command.replace(
				options.rootPassword ?? "<rootPassword_insertion_ogi_addon_system>",
				"<root password>",
			) +
			" " +
			args.join(" "),
	);
	const childProcess = spawn(command, args, spawnOptions);
	let stdout = "";
	let stderr = "";

	if (childProcess.stdout) {
		childProcess.stdout.on("data", (data: Buffer) => {
			const dataStr = data.toString();
			stdout += dataStr;
			if (options.stdout) {
				options.stdout(
					dataStr.replace(
						options.rootPassword ?? "<rootPassword_insertion_ogi_addon_system>",
						"<root password>",
					),
				);
			}
		});
	}

	if (childProcess.stderr) {
		childProcess.stderr.on("data", (data: Buffer) => {
			const dataStr = data.toString();
			stderr += dataStr;
			if (options.stderr) {
				options.stderr(dataStr);
			}
		});
	}

	if (options.onClose) {
		childProcess.on("close", (code: number) => {
			options.onClose?.(code);
		});
	}

	if (options.onError) {
		childProcess.on("error", (err: Error) => {
			options.onError?.(err);
		});
	}

	return {
		process: childProcess,
		stdout,
		stderr,
		stdin: childProcess.stdin,
	};
}

type SetupManifest = {
	service?: string;
	setupExe?: string;
	pathOfSetupExe?: string;
	installUpdateGroups?: DownloadedUpdateGroup[];
	installUpdateTargetVersion?: string;
	// Scraped from the repack page at search time; null when the page omits
	// the figure. Used as the install-progress denominator.
	originalSizeBytes?: number | null;
	hddSpaceAfterInstallBytes?: number | null;
};

function resolveSelectedFilePath(
	selectedPath: string | undefined,
	baseDir?: string,
): string | undefined {
	if (!selectedPath) {
		return undefined;
	}

	let normalizedPath = selectedPath.trim();
	if (!normalizedPath) {
		return undefined;
	}

	if (normalizedPath.startsWith("file://")) {
		try {
			normalizedPath = fileURLToPath(normalizedPath);
		} catch {
			return undefined;
		}
	}

	if (fs.existsSync(normalizedPath)) {
		return normalizedPath;
	}

	if (baseDir) {
		const relativeToBaseDir = join(baseDir, normalizedPath);
		if (fs.existsSync(relativeToBaseDir)) {
			return relativeToBaseDir;
		}
	}

	return normalizedPath;
}

function findInstallerExeCandidates(repackPath: string): string[] {
	const directories = [repackPath];
	const foundExes: string[] = [];

	while (directories.length > 0) {
		const currentDirectory = directories.pop();
		if (!currentDirectory) {
			continue;
		}

		try {
			const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(currentDirectory, entry.name);
				if (entry.isDirectory()) {
					const lowerName = entry.name.toLowerCase();
					if (
						lowerName === "install_here" ||
						lowerName === "install here" ||
						lowerName === "__macosx"
					) {
						continue;
					}
					directories.push(fullPath);
					continue;
				}

				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".exe")) {
					continue;
				}

				foundExes.push(fullPath);
			}
		} catch {}
	}

	return foundExes.sort((left, right) => {
		const leftBase = basename(left).toLowerCase();
		const rightBase = basename(right).toLowerCase();
		const leftIsSetup = leftBase === "setup.exe";
		const rightIsSetup = rightBase === "setup.exe";
		if (leftIsSetup !== rightIsSetup) {
			return leftIsSetup ? -1 : 1;
		}

		const leftHasSetup = leftBase.includes("setup");
		const rightHasSetup = rightBase.includes("setup");
		if (leftHasSetup !== rightHasSetup) {
			return leftHasSetup ? -1 : 1;
		}

		const leftDepth = left.split(/[\\/]/).length;
		const rightDepth = right.split(/[\\/]/).length;
		if (leftDepth !== rightDepth) {
			return leftDepth - rightDepth;
		}

		return left.localeCompare(right);
	});
}

async function resolveFitgirlSetupExe(
	repackPath: string,
	manifest: SetupManifest | undefined,
	event: {
		fail: (msg: string) => void;
		askForInput: (
			title: string,
			message: string,
			builder: ConfigurationBuilder,
		) => Promise<Record<string, string | boolean | undefined>>;
	},
): Promise<string | null> {
	const local =
		manifest?.service === "local"
			? resolveSelectedFilePath(manifest.setupExe, manifest.pathOfSetupExe)
			: undefined;
	if (local && fs.existsSync(local)) {
		return local;
	}

	const primary = join(repackPath, "setup.exe");
	if (fs.existsSync(primary)) {
		return primary;
	}

	let exes: string[] = [];
	try {
		exes = findInstallerExeCandidates(repackPath);
	} catch {
		event.fail("Could not read the repack directory.");
		return null;
	}

	if (exes.length === 0) {
		event.fail(
			"No .exe installers found in the repack directory. Ensure extraction finished.",
		);
		return null;
	}

	if (exes.length === 1) {
		return exes[0];
	}
	const exactSetupExecutables = exes.filter(
		(exe) => basename(exe).toLowerCase() === "setup.exe",
	);
	if (exactSetupExecutables.length === 1) {
		return exactSetupExecutables[0];
	}

	const picked = (await event.askForInput(
		"FitGirl Repacks",
		"Select the setup.exe file",
		new ConfigurationBuilder().addStringOption((option) =>
			option
				.setName("setupExe")
				.setDisplayName("Setup.exe")
				.setDescription("Select the installer .exe in your repack directory")
				.setInputType("file")
				.setAllowedValues(exes)
				.setDefaultValue(exes[0]),
		),
	)) as { setupExe: string };

	const selectedSetupExe = resolveSelectedFilePath(picked.setupExe, repackPath);
	if (!selectedSetupExe || !fs.existsSync(selectedSetupExe)) {
		event.fail("The selected setup.exe file does not exist.");
		return null;
	}

	return selectedSetupExe;
}

type UpdateSetupData = Extract<
	Parameters<EventListenerTypes["setup"]>[0],
	{ for: "update" }
>;
type SetupEvent = Parameters<EventListenerTypes["setup"]>[1];

function runUpdateSetup(data: UpdateSetupData, event: SetupEvent): void {
	event.defer(async () => {
		const { currentLibraryInfo, manifest, appID, path } = data;
		if (
			manifest?.service !== "local-update" &&
			manifest?.service !== "filecrypt-update"
		) {
			event.fail("Unknown update manifest service");
			return;
		}

		const packages =
			manifest.service === "filecrypt-update"
				? resolveDownloadedUpdatePackages(
						path,
						(manifest.groups as DownloadedUpdateGroup[] | undefined) ?? [],
					)
				: ((manifest.packages as string[] | undefined) ?? []);
		const downloadArtifacts =
			manifest.service === "filecrypt-update"
				? ((manifest.groups as DownloadedUpdateGroup[] | undefined) ?? [])
						.flatMap((group) => group.files)
						.map((file) => join(path, file))
				: [];
		if (packages.length === 0) {
			event.fail("No update packages were selected");
			return;
		}

		const record = loadInstalledRepack(appID);
		// OGI validates the resolved version against the one check-for-updates
		// reported; anything else marks the update failed.
		const targetVersion =
			(manifest.targetVersion as string | undefined) ??
			record?.pendingUpdateVersion ??
			"unknown";

		const installDir = installDirOf(currentLibraryInfo);
		try {
			// Clean up any interrupted previous attempt before starting a new one.
			recoverUpdateTransaction(installDir, (message) => event.log(message));

			const { backupDir } = await applyLocalUpdatePackages({
				packages,
				downloadArtifacts,
				targetVersion,
				currentLibraryInfo,
				context: {
					platform: process.platform,
					umuRunPath: UMU_BIN,
					homeDir: process.env.HOME || process.env.USERPROFILE || "~/",
				},
				log: (message) => event.log(message),
			});

			if (record) {
				record.installedVersion = targetVersion;
				record.pendingUpdateVersion = undefined;
				record.pendingBackupDir = backupDir;
				record.appliedUpdates.push({
					version: targetVersion,
					packages,
					appliedAt: new Date().toISOString(),
				});
				saveInstalledRepack(record);
			}
		} catch (err) {
			event.fail(
				`Update failed and the installation was left untouched: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		// Launch metadata must survive the update, including the UMU association.
		event.resolve({
			version: targetVersion,
			cwd: currentLibraryInfo.cwd,
			launchExecutable: currentLibraryInfo.launchExecutable,
			launchArguments: currentLibraryInfo.launchArguments ?? "",
			launchEnv: currentLibraryInfo.launchEnv,
			redistributables: currentLibraryInfo.redistributables,
			umu: currentLibraryInfo.umu,
		});
	});
}

addon.on("setup", (data, event) => {
	let {
		path,
		type,
		name,
		usedRealDebrid,
		appID,
		storefront,
		multiPartFiles,
		manifest,
	} = data;
	if (data.for === "update") {
		runUpdateSetup(data, event);
		return;
	}
	const wineSource = addon.config.getStringValue("whereToWine") || "flatpak";
	event.defer();
	event.log("Setting up fitgirl game...");
	// check if wine is instaleld in that source by running the help command check if it fails

	void (async () => {
		const setupManifest = manifest as SetupManifest | undefined;
		const installUpdateGroups = setupManifest?.installUpdateGroups ?? [];
		const updateFileNames = new Set(
			installUpdateGroups.flatMap((group) => group.files),
		);
		// this was a direct download, we need to multipart unrar these files
		event.log(type);
		if (manifest && manifest.service === "local") {
			path = manifest.pathOfSetupExe as string;
			event.log(`Using local setup.exe file: ${path}`);
		}

		let continueFlag = false;
		// if the INSTALL_HERE folder already exists, and it has content in it, ask the user if they already completed the download or want to retry
		if (
			fs.existsSync(join(path, "INSTALL_HERE")) &&
			fs.readdirSync(join(path, "INSTALL_HERE")).length > 0
		) {
			const result = await event.askForInput(
				"Installation Exists",
				"An installation has already been attempted in this folder. Do you want to retry the extraction or continue with the existing files?",
				new ConfigurationBuilder()
					.addActionOption((option) =>
						option
							.setButtonText("Retry")
							.setName("retry")
							.setDescription("Do you want to retry the download?"),
					)
					.addActionOption((option) =>
						option
							.setButtonText("Continue")
							.setName("continue")
							.setDescription("Do you want to cancel the download?"),
					),
			);
			continueFlag = result?.continue;
		} else if (
			type === "direct" &&
			Array.isArray(multiPartFiles) &&
			multiPartFiles.length > 0
		) {
			event.log(
				"Unraring downloaded contents... This may take a while depending on the size of the files, amount of files, and speed of your computer. Please be patient.",
			);
			try {
				// Direct hosters use synthetic partN.rar names for independent archives.
				const baseParts = multiPartFiles.filter(
					(part) => !updateFileNames.has(part.name),
				);
				const extractionJobs: ExtractionJob[] = baseParts.map((part) => {
					const filePath = join(path, part.name);
					const size = Math.max(fs.statSync(filePath).size, 1);
					return process.platform === "win32"
						? {
								command: "C:\\Program Files\\7-Zip\\7z.exe",
								args: ["x", filePath, "-bso0", "-bsp1", "-y"],
								cwd: path,
								size,
								parseProgress: parseSevenZipProgress,
							}
						: {
								command: "unrar",
								args: ["x", filePath, path, "-idn", "-kb", "-y"],
								size,
								parseProgress: parseUnrarProgress,
							};
				});
				await extractAllWithProgress(extractionJobs, (progress) => {
					event.progress = progress;
				});
				event.log(`Unrar completed for ${baseParts.length} archive(s)`);
			} catch (error) {
				event.fail(`Failed to extract downloaded files: ${String(error)}`);
				return;
			}
			// now delete the rar files
			event.log("Deleting rar files..");
			for (const part of multiPartFiles.filter(
				(part) => !updateFileNames.has(part.name),
			)) {
				const filePath = join(path, part.name);
				try {
					if (fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
						event.log(`Deleted archive file: ${part.name}`);
					}
				} catch (err) {
					event.log(`Failed to delete archive file ${part.name}: ${err}`);
				}
			}
		}

		let installDir = "";

		if (continueFlag) {
			// The user chose to continue with existing files — skip wine entirely
			// and jump straight to the executable-finding step.
			event.log(
				"Skipping wine execution, continuing with existing installation...",
			);
			const continueInput = (await event.askForInput(
				"FitGirl Repacks",
				"Where did you previously install " +
					name +
					"? Select the directory so we can find the game executable.",
				new ConfigurationBuilder().addStringOption((option) =>
					option
						.setName("installDir")
						.setDisplayName("Game Installation Directory")
						.setDescription(
							"Select the directory where the game was previously installed.",
						)
						.setDefaultValue(path)
						.setInputType("folder"),
				),
			)) as { installDir: string };
			installDir = continueInput.installDir;
		} else {
			const homeDir = process.env.HOME || process.env.USERPROFILE || "~/";
			const winePrefixDir = join(homeDir, ".wine-fitgirl");
			const runsSetupViaWine = process.platform !== "win32";
			const defaultInstallDir = defaultInstallDirectory(path);
			const sikarugirBin = sikarugirLauncher(homeDir);
			const sikarugirWineBin = sikarugirWine(homeDir);
			const sikarugirWinePrefix = sikarugirPrefix(homeDir);
			const sikarugirFrameworkPath = sikarugirFrameworks(homeDir);
			const useSikarugir =
				process.platform === "darwin" &&
				fs.existsSync(sikarugirBin) &&
				fs.existsSync(sikarugirWineBin);

			const setupExePath = await resolveFitgirlSetupExe(
				path,
				manifest as SetupManifest | undefined,
				event,
			);
			if (!setupExePath) {
				return;
			}

			const setupDir = dirname(setupExePath);
			const bins = sniffRepackBins(setupDir);
			const optionNameFor = (group: OptionalBinGroup): string =>
				"optional_" + group.key.replaceAll("-", "_");

			const screen = new ConfigurationBuilder()
				.addBooleanOption((option) =>
					option
						.setName("automate")
						.setDisplayName("Automate Setup")
						.setDescription(
							"Silently run the installer straight into the chosen directory (skips redists, hosts-file tweaks, and the installer music).",
						)
						.setDefaultValue(true),
				)
				.addStringOption((option) =>
					option
						.setName("installDir")
						.setDisplayName("Game Installation Directory")
						.setDescription(
							"Choose where you want to install the game (this should be different from where the setup files are located)",
						)
						.setDefaultValue(defaultInstallDir)
						.setInputType("folder"),
				);
			for (const group of bins.optional) {
				screen.addBooleanOption((option) =>
					option
						.setName(optionNameFor(group))
						.setDisplayName("Include " + group.label)
						.setDescription(
							`Install the optional ${group.label} (${(group.size / 2 ** 30).toFixed(1)} GiB).`,
						)
						.setDefaultValue(false),
				);
			}

			const input = (await event.askForInput(
				"FitGirl Repacks",
				"Setup your FitGirl Repack",
				screen,
			)) as
				| ({ automate: boolean; installDir: string } & Record<
						string,
						boolean | string
				  >)
				| undefined;
			if (!input?.installDir) {
				event.fail("Setup was cancelled before choosing an install directory.");
				return;
			}

			// check if the installDir is a valid path, then check if there is content inside the installDir
			if (!fs.existsSync(input.installDir)) {
				event.fail(
					"Error: installDir is not a valid path. Please enter a valid path.",
				);
				return;
			}
			const existingFiles = fs
				.readdirSync(input.installDir)
				.filter((file) => file !== ".torrent" && file !== "old_files");
			if (existingFiles.length !== 0 && path !== input.installDir) {
				input.installDir = join(input.installDir, name);
				event.log(
					`installDir is not empty and path is not the same as installDir, so we will append the game name to the installDir to prevent deleting entire folder contents.`,
				);
			}

			installDir = input.installDir as string;
			const includedOptional = bins.optional.filter(
				(group) => input[optionNameFor(group)] === true,
			);
			const excludedOptional = bins.optional.filter(
				(group) => input[optionNameFor(group)] !== true,
			);

			// The manual Wine flow installs into a staging folder first; the
			// silent flow writes straight into the target.
			if (runsSetupViaWine && !input.automate) {
				fs.mkdirSync(join(installDir, "INSTALL HERE"), { recursive: true });
			}

			if (input.automate) {
				fs.mkdirSync(installDir, { recursive: true });
				const restoreBins = excludeOptionalBins(setupDir, excludedOptional);
				let lastPhase = "extracting";
				const stopTracking = trackInstallProgress(
					installDir,
					estimateInstalledBytes(bins, includedOptional, setupManifest),
					(update) => {
						event.progress = update.progress;
						if (update.phase !== lastPhase) {
							lastPhase = update.phase;
							event.log(
								update.phase === "verifying"
									? "The installer is verifying files (disk growth has stopped); this can take a while and the progress bar will hold until it finishes."
									: "The installer resumed writing files.",
							);
						}
					},
				);
				try {
					if (useSikarugir) {
						// Sikarugir ships its own Wine; drive the silent install
						// through an INF instead of the umu launch plan.
						const setupINFPath = join(path, "fatboy-setup.inf");
						fs.writeFileSync(
							setupINFPath,
							makeSetupINF(
								toWinePath(installDir),
								includedOptional.length > 0,
							),
						);
						event.log(`Setup INF file created at ${setupINFPath}`);
						event.log(
							"Running the repack installer silently. Progress is estimated from the install directory's growth on disk.",
						);
						execFileSync(
							sikarugirWineBin,
							[
								setupExePath,
								"/SP-",
								"/VERYSILENT",
								"/SUPPRESSMSGBOXES",
								"/NORESTART",
								"/LANG=en",
								`/LOADINF=${toWinePath(setupINFPath)}`,
							],
							{
								cwd: path,
								env: {
									...process.env,
									DYLD_FALLBACK_LIBRARY_PATH: sikarugirFrameworkPath,
									WINEPREFIX: sikarugirWinePrefix,
								},
								stdio: "inherit",
							},
						);
					} else {
						const umu: UmuContext | undefined = runsSetupViaWine
							? {
									umuRunPath: UMU_BIN,
									gameId: `umu-${appID}`,
									winePrefix: winePrefixDir,
								}
							: undefined;
						if (umu) {
							// FitGirl's installer music comes from its own audio code, so
							// /VERYSILENT alone is not a guaranteed mute; killing the Wine
							// audio driver in the install prefix is.
							event.log("Muting audio in the installer's Wine prefix...");
							await runInstaller(buildMuteAudioPlan(umu));
						}

						const plan = buildInstallerLaunchPlan(
							{
								installerExe: setupExePath,
								installDir,
								logFile: join(setupDir, "fatboy-install.log"),
								components: componentCandidates(includedOptional),
								tasks: [],
							},
							{ platform: process.platform, umu },
						);
						event.log(
							"Running the repack installer silently. Progress is estimated from the install directory's growth on disk.",
						);
						const result = await runInstaller(plan, (line) => {
							const trimmed = line.trim();
							if (trimmed) event.log(trimmed);
						});
						if (result.exitCode !== 0) {
							event.fail(
								`The repack installer exited with code ${result.exitCode}. ` +
									`Check ${join(setupDir, "fatboy-install.log")} for details.`,
							);
							return;
						}
					}
					event.progress = 100;
					event.log("Repack installer finished.");
				} catch (err) {
					event.fail(
						`Error running setup.exe${runsSetupViaWine ? (useSikarugir ? " via Sikarugir" : " via Wine/UMU") : ""}: ${err instanceof Error ? err.message : String(err)}`,
					);
					return;
				} finally {
					stopTracking();
					restoreBins();
				}
			} else {
				event.log(`Opening setup.exe`);
				if (process.platform === "win32") {
					try {
						execSync(`"${setupExePath}"`, { cwd: path });
					} catch (_err) {
						event.fail(
							"Error opening setup.exe. It's possible that Windows quarantined the file. Please try again.",
						);
						return;
					}
				} else if (runsSetupViaWine) {
					let acknowledged = false;
					while (!acknowledged) {
						let acknowledge = await event.askForInput(
							"FitGirl Repacks",
							"Before we launch the setup, it's important to know that when you are selecting the destination location, you MUST use the Z drive (even if you are using an SD Card). If you are using an SD Card, go to Z:\\" +
								installDir.replaceAll("/", "\\") +
								"\\INSTALL HERE",
							new ConfigurationBuilder().addBooleanOption((option) =>
								option
									.setDisplayName("I Understand")
									.setName("understood")
									.setDescription(
										"I understand that I need to use the Z drive in order to properly install my repack.",
									)
									.setDefaultValue(false),
							),
						);
						if (acknowledge.understood === true) {
							acknowledge = await event.askForInput(
								"FitGirl Repacks",
								'When selecting the destination location, select the folder with the name "INSTALL HERE" so we can smoothly move the contents of the folder to the path.',
								new ConfigurationBuilder().addBooleanOption((option) =>
									option
										.setDisplayName("I Understand")
										.setName("understood")
										.setDescription(
											'I understand that I need to select the folder with the name "INSTALL HERE" so FatBoy can smoothly move the contents of the folder to the path.',
										)
										.setDefaultValue(false),
								),
							);
							if (acknowledge.understood === true) {
								acknowledged = true;
							}
						}
					}
					event.log(`Acknowledged`);
					let forceStop = false;
					if (useSikarugir) {
						try {
							await new Promise<string>((resolve, reject) =>
								spawnAndHook(
									{
										cwd: path,
										stdout: (data: string) => event.log(data),
										stderr: (data: string) => event.log(data),
										onClose: (code: number) =>
											code === 0
												? resolve("Process completed successfully")
												: reject(
														new Error(`Process exited with code ${code}`),
													),
										onError: (err: Error) => reject(err),
									},
									sikarugirBin,
									["WSS-installer", setupExePath],
								),
							);
						} catch (err) {
							event.log(`Error opening setup.exe: ${err}`);
							event.fail(
								"Error opening setup.exe via Sikarugir. Check OGI's Windows support setup and try again.",
							);
							forceStop = true;
						}
					} else if (wineSource === "umu" || wineSource === "flatpak") {
						try {
							await new Promise<string>((resolve, reject) =>
								spawnAndHook(
									{
										cwd: path,
										env: {
											WINEPREFIX: winePrefixDir,
											...process.env,
										} as Record<string, string>,
										stdout: (data: string) => {
											event.log(data);
										},
										stderr: (data: string) => {
											event.log(data);
										},
										onClose: (code: number) => {
											console.log("onClose", code);
											if (code === 0) {
												resolve("Process completed successfully");
											} else {
												reject(new Error(`Process exited with code ${code}`));
											}
										},
										onError: (err: Error) => {
											reject(err);
										},
									},
									UMU_BIN,
									[setupExePath],
								),
							);
						} catch (err) {
							event.log(`Error opening setup.exe: ${err}`);
							event.fail(
								'Error opening setup.exe. Check if wine is installed in "' +
									wineSource +
									'" and if it is, try again.',
							);
							forceStop = true;
						}

						if (forceStop) {
							return;
						}

						// ask if the user has finished the setup process
						const finishedSetup = await event.askForInput(
							"FitGirl Repacks",
							`Have you finished the setup process for ${name}?`,
							new ConfigurationBuilder().addBooleanOption((option) =>
								option
									.setDisplayName("Finished Setup")
									.setName("finishedSetup")
									.setDescription("Have you finished the setup process?")
									.setDefaultValue(false),
							),
						);
						if (finishedSetup.finishedSetup === false) {
							event.fail(
								"Error: you have not finished the setup process. Please finish the setup process and try again.",
							);
							return;
						}

						// Keep downloaded update packages until they are staged below.
						event.log(
							`Cleaning setup files while preserving automatic update packages`,
						);
						fs.readdirSync(path).forEach((file) => {
							if (file !== "INSTALL HERE" && !updateFileNames.has(file)) {
								const fullPath = join(path, file);
								const stat = fs.lstatSync(fullPath);
								if (stat.isDirectory()) {
									fs.rmSync(fullPath, { recursive: true, force: true });
								} else {
									fs.unlinkSync(fullPath);
								}
							}
						});
						event.log("Deleted.");

						// move the contents of 'INSTALL HERE' directory to the path
						const installHereDir = join(installDir, "INSTALL HERE");

						if (fs.existsSync(installHereDir)) {
							// Check if there's content in INSTALL HERE
							const installHereFiles = fs.readdirSync(installHereDir);

							if (installHereFiles.length > 0) {
								// If there's a single nested folder, move its contents up
								if (
									installHereFiles.length === 1 &&
									fs
										.statSync(join(installHereDir, installHereFiles[0]))
										.isDirectory()
								) {
									const nestedDir = join(installHereDir, installHereFiles[0]);
									const nestedFiles = fs.readdirSync(nestedDir);

									// Move all files from the nested directory to the parent path
									for (const file of nestedFiles) {
										const sourcePath = join(nestedDir, file);
										const destPath = join(installDir, file);
										fs.renameSync(sourcePath, destPath);
									}
									event.log(
										`Moved contents from nested directory '${installHereFiles[0]}' to ${installDir}`,
									);
								} else {
									// Move all files from INSTALL HERE to the parent path
									for (const file of installHereFiles) {
										const sourcePath = join(installHereDir, file);
										const destPath = join(installDir, file);
										fs.renameSync(sourcePath, destPath);
									}
									event.log(
										`Moved contents from 'INSTALL HERE' directory to ${installDir}`,
									);
								}

								// then, delete the 'INSTALL HERE' directory
								fs.rmSync(installHereDir, { recursive: true, force: true });
							}

							// Remove the now-empty INSTALL HERE directory
							fs.rmSync(installHereDir, { recursive: true, force: true });
						}
					}
				}
			}
		} // end of !continueFlag else block

		// Function to find executable files in a directory
		function findExecutableFiles(directory: string): string[] {
			if (!fs.existsSync(directory)) {
				return [];
			}

			const files = fs.readdirSync(directory);
			const executableExtensions = [".exe", ".bat", ".cmd"];
			const excludePatterns = [
				/unitycrash/i,
				/crash.*report/i,
				/error.*report/i,
				/setup/i,
				/install/i,
				/uninstall/i,
				/redist/i,
				/vcredist/i,
				/directx/i,
				/_commonredist/i,
				/updater/i,
				/launcher.*update/i,
				/^steam_/i,
			];

			return files
				.filter((file) => {
					const filePath = join(directory, file);
					const stats = fs.statSync(filePath);

					// Skip directories
					if (stats.isDirectory()) {
						return false;
					}

					// Check if it has an executable extension
					const hasExeExtension = executableExtensions.some((ext) =>
						file.toLowerCase().endsWith(ext),
					);

					if (!hasExeExtension) {
						return false;
					}

					// Exclude unwanted files
					const shouldExclude = excludePatterns.some((pattern) =>
						pattern.test(file),
					);

					return !shouldExclude;
				})
				.map((file) => join(directory, file));
		}

		// okay installed!

		// Try to auto-detect the executable first
		const potentialExecutables = findExecutableFiles(installDir);
		let gameExecutable: { workingDir: string; gameExecutable: string };

		if (potentialExecutables.length === 1) {
			// Auto-select the single executable found
			event.log(`Auto-detected game executable: ${potentialExecutables[0]}`);
			gameExecutable = {
				workingDir: installDir,
				gameExecutable: potentialExecutables[0],
			};
		} else {
			// Ask user to select manually
			if (potentialExecutables.length === 0) {
				event.log(
					"No executable files found automatically. Please select manually.",
				);
			} else {
				event.log(
					`Found ${potentialExecutables.length} potential executables. Please select manually.`,
				);
			}

			gameExecutable = (await event.askForInput(
				"FitGirl Repacks",
				"Help us help you.",
				new ConfigurationBuilder()
					.addStringOption((option) =>
						option
							.setName("workingDir")
							.setDisplayName("Working Directory")
							.setDescription(
								"Go to the directory: " +
									(installDir ?? "(where you installed it)") +
									" and select the working directory. (usually where the game executable is located)",
							)
							.setInputType("folder")
							.setDefaultValue(installDir),
					)
					.addStringOption((option) =>
						option
							.setName("gameExecutable")
							.setDisplayName("Game Executable")
							.setDescription(
								"Go to the directory: " +
									(installDir ?? "(where you installed it)") +
									" and select the game executable.",
							)
							.setInputType("file"),
					),
			)) as { workingDir: string; gameExecutable: string };
		}

		// exec(setupPath)
		// check if the working directory contains unity. if it does, then no need to run any dependencies
		// check the files in the working directory folder and if one of the names contains "unityplayer.dll" then no need to run any dependencies
		const workingDir = gameExecutable.workingDir as string;
		const files = fs.readdirSync(workingDir);
		let _hasUnity = false;
		if (files.some((file) => file.toLowerCase().includes("unityplayer.dll"))) {
			_hasUnity = true;
		}

		const redistributables: { name: string; path: string }[] = [];

		if (process.platform === "linux") {
			redistributables.push({
				name: "dotnet40",
				path: "winetricks",
			});
			// always install common redistributables (no prompt)
			redistributables.push({
				name: "dotnet48",
				path: "winetricks",
			});
			redistributables.push({
				name: "vcrun2022",
				path: "winetricks",
			});
			redistributables.push({
				name: "xna40",
				path: "winetricks",
			});
		}

		// write a file steam_appid.txt in the installDir with the steamAppId if it doesn't exist
		if (!fs.existsSync(join(installDir, "steam_appid.txt"))) {
			fs.writeFileSync(join(installDir, "steam_appid.txt"), appID.toString());
		}

		// if there's a "winmm.dll" in the executable path, we need to add it to winedlls
		const winedlls: string[] = [];
		// get all .dll files in the installDir and add them to winedlls
		const dllFiles = fs
			.readdirSync(installDir)
			.filter((file) => file.toLowerCase().endsWith(".dll"));
		for (const dllFile of dllFiles) {
			if (fs.existsSync(join(installDir, dllFile))) {
				winedlls.push(dllFile.replaceAll(".dll", ""));
			}
		}

		// The installed version comes from the repack release itself, never
		// Steam's latestVersion; "unknown" is honest when the source omits one.
		const sourceRelease = manifest?.fitgirlRelease as string | undefined;
		const baseVersion = extractRepackVersion(sourceRelease);
		let version = baseVersion;
		let pendingBackupDir: string | undefined;
		const appliedUpdates: {
			version: string;
			packages: string[];
			appliedAt: string;
		}[] = [];
		if (installUpdateGroups.length > 0) {
			const packages = resolveDownloadedUpdatePackages(
				path,
				installUpdateGroups,
			);
			const targetVersion =
				setupManifest?.installUpdateTargetVersion ?? baseVersion;
			try {
				event.log(
					`Applying ${packages.length} FitGirl update package(s) before finishing installation...`,
				);
				const result = await applyLocalUpdatePackages({
					packages,
					downloadArtifacts: installUpdateGroups
						.flatMap((group) => group.files)
						.map((file) => join(path, file)),
					targetVersion,
					currentLibraryInfo: {
						appID,
						cwd: installDir,
						launchExecutable: relative(
							installDir,
							gameExecutable.gameExecutable,
						),
						umu: { umuId: `steam:${appID}` },
					},
					context: {
						platform: process.platform,
						umuRunPath: UMU_BIN,
						homeDir: process.env.HOME || process.env.USERPROFILE || "~/",
					},
					log: (message) => event.log(message),
				});
				version = targetVersion;
				pendingBackupDir = result.backupDir;
				appliedUpdates.push({
					version: targetVersion,
					packages,
					appliedAt: new Date().toISOString(),
				});
			} catch (error) {
				event.fail(
					`The base game installed, but its automatic updates failed safely: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
		}
		saveInstalledRepack({
			appID,
			storefront,
			name,
			fitgirlUrl: manifest?.fitgirlUrl as string | undefined,
			sourceRelease,
			installDir,
			installedVersion: version,
			pendingBackupDir,
			appliedUpdates,
		});
		event.resolve({
			cwd: gameExecutable.workingDir as string,
			launchExecutable: gameExecutable.gameExecutable as string,
			version,
			launchArguments: process.platform === "linux" ? "%command%" : "%command%",
			redistributables,
			umu: {
				umuId: `steam:${appID}` as `steam:${number}`,
				dllOverrides: winedlls.map((dll) => `${dll.toLowerCase()}=n,b`),
			},
		});
	})();
});

type DirectDownloadFile = { name: string; downloadURL: string };

async function resolveAutomaticFitGirlUpdates(
	gameName: string,
	log: (message: string) => void,
	knownUpdates?: FitGirlUpdate[],
): Promise<{
	files: DirectDownloadFile[];
	groups: DownloadedUpdateGroup[];
	targetVersion?: string;
}> {
	const updates =
		knownUpdates ??
		parseFitGirlUpdates(
			(await axiosGetWithDDOSGuard(addon, FITGIRL_UPDATES_URL, {})).data,
			gameName,
		);
	const files: DirectDownloadFile[] = [];
	const groups: DownloadedUpdateGroup[] = [];

	for (const [groupIndex, update] of updates.entries()) {
		log(`Resolving update ${groupIndex + 1}/${updates.length}: ${update.name}`);
		const unlocked = await unlockFileCryptContainer(update.url, {
			request: requestFileCryptResource,
			renderContainer: renderFileCryptContainer,
		});
		const supportedLinks = unlocked.filter((link) => {
			try {
				return resolveServiceFromUrl(link.url).name === "FuckingFast";
			} catch {
				return false;
			}
		});
		if (supportedLinks.length === 0) {
			throw new Error(`No supported FuckingFast files found for ${update.name}`);
		}

		const resolved = await resolveFuckingFastUpdateFiles(
			supportedLinks,
			catchDownload,
		);
		const groupFiles = resolved.map((file) => ({
			...file,
			name: `update${groupIndex}-${file.name}`,
		}));
		files.push(...groupFiles);
		groups.push({ files: groupFiles.map((file) => file.name) });
	}

	return {
		files,
		groups,
		targetVersion:
			updates.length > 0
				? inferUpdateTargetVersion(updates.at(-1)?.name)
				: undefined,
	};
}

addon.on("request-dl", (appID, info, event) => {
	event.defer(async () => {
		if (!info.manifest) {
			event.fail("No manifest found");
			return;
		}
		console.log("Download request for appID:", appID, info.manifest);
		if (info.manifest.service === "FuckingFast") {
			const links = info.manifest.links as { name: string; url: string }[];
			try {
				const baseFiles = await resolveFuckingFastFiles(
					links,
					catchDownload,
					(found, total) =>
						addon.notify({
							message: `Found link (${found}/${total}) for ${info.name}`,
							id: "fatboy-unpack-download-link-found",
							type: "success",
						}),
				);
				const updates = await resolveAutomaticFitGirlUpdates(
					(info.manifest.fitgirlGameName as string | undefined) ?? info.name,
					(message) => event.log(message),
				);
				event.resolve({
					name: `FuckingFast | ${info.name}`,
					downloadType: "direct",
					files: [...baseFiles, ...updates.files],
					manifest: {
						...info.manifest,
						installUpdateGroups: updates.groups,
						installUpdateTargetVersion: updates.targetVersion,
					},
				});
			} catch (error) {
				event.fail(error instanceof Error ? error.message : String(error));
			}
		} else if (info.manifest.service === "FileCrypt") {
			const containers = info.manifest.links as { name: string; url: string }[];
			try {
				const unlocked = (
					await Promise.all(
						containers.map((container) =>
							unlockFileCryptContainer(container.url, {
								request: requestFileCryptResource,
								renderContainer: renderFileCryptContainer,
							}),
						),
					)
				).flat();
				const fuckingFastLinks = Array.from(
					new Map(
						unlocked
							.filter((link) => {
								try {
									return resolveServiceFromUrl(link.url).name === "FuckingFast";
								} catch {
									return false;
								}
							})
							.map((link) => [link.url, link]),
					).values(),
				);
				if (fuckingFastLinks.length === 0) {
					throw new Error(
						"FileCrypt container did not contain supported FuckingFast links",
					);
				}
				const baseFiles = await resolveFuckingFastFiles(
					fuckingFastLinks,
					catchDownload,
					(found, total) =>
						addon.notify({
							message: `Found link (${found}/${total}) for ${info.name}`,
							id: "fatboy-unpack-download-link-found",
							type: "success",
						}),
				);
				const updates = await resolveAutomaticFitGirlUpdates(
					(info.manifest.fitgirlGameName as string | undefined) ?? info.name,
					(message) => event.log(message),
				);
				event.resolve({
					name: `FileCrypt | ${info.name}`,
					downloadType: "direct",
					files: [...baseFiles, ...updates.files],
					manifest: {
						...info.manifest,
						installUpdateGroups: updates.groups,
						installUpdateTargetVersion: updates.targetVersion,
					},
				});
			} catch (error) {
				event.fail(error instanceof Error ? error.message : String(error));
			}
		} else if (info.manifest.service === "filecrypt-update") {
			const updates = info.manifest.updates as { name: string; url: string }[];
			if (updates.length === 0) {
				event.fail("No FitGirl update packages were found");
				return;
			}

			try {
				const resolvedUpdates = await resolveAutomaticFitGirlUpdates(
					info.name,
					(message) => event.log(message),
					updates,
				);
				event.resolve({
					name: `FileCrypt Updates | ${info.name}`,
					downloadType: "direct",
					files: resolvedUpdates.files,
					manifest: {
						...info.manifest,
						service: "filecrypt-update",
						groups: resolvedUpdates.groups,
						targetVersion:
							(info.manifest.targetVersion as string | undefined) ??
							resolvedUpdates.targetVersion,
					},
					clearOldFilesBeforeUpdate: false,
				});
			} catch (error) {
				event.fail(error instanceof Error ? error.message : String(error));
			}
		} else if (info.manifest.service === "local-update") {
			// Local-package MVP: the user points us at every updater package for the
			// chain, oldest first. Each is staged and applied in this order.
			const packages: string[] = [];
			let addMore = true;
			while (addMore) {
				const picked = (await event.askForInput(
					"FitGirl Repacks",
					packages.length === 0
						? "Select the first update package (.rar or updater .exe). If this update requires earlier updates, select the oldest one first."
						: `Selected ${packages.length} package(s). Add the next update package, or finish.`,
					new ConfigurationBuilder()
						.addStringOption((option) =>
							option
								.setName("packageFile")
								.setDisplayName("Update Package")
								.setDescription(
									"The downloaded update package (.rar or updater .exe)",
								)
								.setInputType("file"),
						)
						.addBooleanOption((option) =>
							option
								.setName("addAnother")
								.setDisplayName("Add Another Package")
								.setDescription(
									"Enable if the target version needs another update applied after this one.",
								)
								.setDefaultValue(false),
						),
				)) as { packageFile: string; addAnother: boolean };

				const resolved = resolveSelectedFilePath(picked.packageFile);
				if (!resolved || !fs.existsSync(resolved)) {
					event.fail("The selected update package does not exist.");
					return;
				}
				packages.push(resolved);
				addMore = picked.addAnother;
			}
			const inferredTarget = inferUpdateTargetVersion(
				basename(packages.at(-1)!),
			);

			event.resolve({
				name: `Local Update | ${info.name}`,
				downloadType: "empty",
				manifest: {
					...info.manifest,
					packages,
					targetVersion:
						inferredTarget === "unknown"
							? info.manifest.targetVersion
							: inferredTarget,
				},
				clearOldFilesBeforeUpdate: false,
			});
		} else if (info.manifest.service === "local") {
			// ask the user to select the setup.exe file
			const setupExe = (await event.askForInput(
				"FitGirl Repacks",
				"Select the setup.exe file",
				new ConfigurationBuilder().addStringOption((option) =>
					option
						.setName("setupExe")
						.setDisplayName("Setup.exe")
						.setDescription(
							"Select the setup.exe file in your repack directory",
						)
						.setInputType("file"),
				),
			)) as { setupExe: string };
			const selectedSetupExe = resolveSelectedFilePath(setupExe.setupExe);
			if (!selectedSetupExe || !fs.existsSync(selectedSetupExe)) {
				event.fail("The selected setup.exe file does not exist.");
				return;
			}

			const pathOfSetupExe = dirname(selectedSetupExe);
			event.resolve({
				name: `Local Files | ${info.name}`,
				downloadType: "empty",
				manifest: {
					service: "local",
					setupExe: selectedSetupExe,
					pathOfSetupExe: pathOfSetupExe,
				},
			});
		} else {
			console.log("unknown manifest service:", info.manifest.service);
		}
	});
});

addon.onTask("re-run-scrapes", async (task_this) => {
	const task = await addon.task();
	await scrapeHer(addon, task);
	task.complete();

	scrapedGames = JSON.parse(fs.readFileSync("fit-scrape-search.json", "utf-8"));
	search = makeSearch();
	search.addItems(scrapedGames!);

	addon.notify({
		message:
			"FitGirl Repacks scraped games updated. Reload the Store Page to see FitGirl results. ",
		id: "fatboy-unpack-scrapes-updated",
		type: "success",
	});
	task_this.complete();
});

addon.on("exit", () => {
	process.exit(0);
});

addon.on("connect", async () => {
	// make interrupted update transactions safe again before anything launches
	for (const record of listInstalledRepacks()) {
		try {
			recoverUpdateTransaction(record.installDir, (message) =>
				console.log(`[update-recovery] ${record.name}: ${message}`),
			);
		} catch (err) {
			console.log(`[update-recovery] ${record.name} failed: ${err}`);
		}
	}

	// detect firstly if we can access fitigrl
	await new Promise<void>((resolve) => {
		axios
			.get("https://fitgirl-repacks.site/", {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				},
			})
			.then(async (_response) => {
				resolve();
			})
			.catch(async (_err) => {
				// solve ddos guard
				const task = await addon.task();
				addon.notify({
					id: "fatboy-unpack-ddos-guard",
					message: "Solving DDOS Guard. This may take a while...",
					type: "info",
				});
				const cookieString = await solveDDOSGuard(
					addon,
					"https://fitgirl-repacks.site/",
					task,
				);
				if (cookieString) {
					// set the cookie
					updateCookieString(cookieString);
					task.log("DDOS Guard successfully solved");
					task.complete();
					addon.notify({
						id: "fatboy-unpack-ddos-guard",
						message: "DDOS Guard successfully solved",
						type: "success",
					});
					resolve();
				}
			});
	});

	void (async () => {
		const task = await addon.task();
		task.log("Checking if scrape is valid...");
		if (!fs.existsSync("fit-scrape-search.json")) {
			addon.notify({
				message: "Scrapes are invalid, scraping FitGirl...",
				id: "fatboy-unpack-scraping",
				type: "info",
			});
			task.log("Scraping FitGirl...");
			await scrapeHer(addon, task);
			scrapedGames = JSON.parse(
				fs.readFileSync("fit-scrape-search.json", "utf-8"),
			);
			search.addItems(scrapedGames!);
			task.log("FitGirl Repacks scraped games loaded");
			addon.notify({
				message: "FatBoy Unpack Ready",
				id: "fatboy-unpack-connected",
				type: "success",
			});
			task.complete();
			return;
		} else {
			scrapedGames = JSON.parse(
				fs.readFileSync("fit-scrape-search.json", "utf-8"),
			);
			search.addItems(scrapedGames!);
			task.log("FitGirl Repacks scraped games loaded");
			addon.notify({
				message: "FatBoy Unpack Ready",
				id: "fatboy-unpack-connected",
				type: "success",
			});
		}
		if (await shouldScrape(2 * 86400000)) {
			addon.notify({
				message: "Updating scrape of FitGirl Repacks...",
				id: "fatboy-unpack-scraping",
				type: "info",
			});
			task.log("Scraping FitGirl...");
			await scrapeHer(addon, task);
			scrapedGames = JSON.parse(
				fs.readFileSync("fit-scrape-search.json", "utf-8"),
			);
			search.addItems(scrapedGames!);
			addon.notify({
				message: "FitGirl Repacks scraped games loaded",
				id: "fatboy-unpack-scraped",
				type: "success",
			});
			task.log("Scraping FitGirl...");
		}
		task.complete();
	})();
});

function generateHash(str: string) {
	return crypto.createHash("sha1").update(str).digest("hex");
}

export async function scrapeGameMetadata(
	game: Game,
	hash: string,
): Promise<GameInfo> {
	const cachePath = `./repack-data-scrapes/${hash}.json`;

	if (fs.existsSync(cachePath)) {
		const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as GameInfo;
		const hasLegacyEmptyFuckingFast = cached.directLinks.some(
			(link) => link.service === "FuckingFast" && link.links.length === 0,
		);
		// Scrapes cached before size fields existed must be refreshed so the
		// install-progress denominator is available.
		const missingSizeFields = cached.originalSizeBytes === undefined;
		if (!hasLegacyEmptyFuckingFast && !missingSizeFields) return cached;
	}

	const response = await axiosGetWithDDOSGuard(addon, game.url, {});
	const data = parseGameMetadataHtml(game, response.data);

	fs.mkdirSync("./repack-data-scrapes", { recursive: true });
	fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));

	return data;
}

function makeSetupINF(installDir: string, addBonus: boolean) {
	return `
[Setup]
Lang=en
Dir=${installDir}
SetupType=custom
Components=text${addBonus ? ",bonus" : ""}
Tasks=
`;
}

/**
 * Component names FitGirl installers commonly use. Inno ignores names the
 * installer does not define, so over-listing is safe; the point is to select
 * the game payload while leaving DirectX/redist components deselected.
 */
function componentCandidates(includedOptional: OptionalBinGroup[]): string[] {
	return [
		"text",
		"game",
		"main",
		...includedOptional.map((group) => group.key),
		...(includedOptional.length > 0 ? ["bonus"] : []),
	].filter((value, index, all) => all.indexOf(value) === index);
}

/**
 * Silent installs report progress by watching the install dir grow, so we
 * need a target size. The scraped page figures are authoritative when
 * available: "HDD space after installation" is the real post-install
 * footprint, "Original Size" a close second. Both describe the full repack,
 * so scale by the selected share of the compressed payload when optional
 * content is deselected. Without a scrape we fall back to 2.5x the selected
 * bin payload — a deliberate overshoot (FitGirl compresses ~1.5-3x) so
 * progress lands short of 100 rather than pinning at 99 early.
 */
function estimateInstalledBytes(
	bins: RepackBins,
	includedOptional: OptionalBinGroup[],
	scraped?: {
		originalSizeBytes?: number | null;
		hddSpaceAfterInstallBytes?: number | null;
	},
): number {
	const selectiveSize = bins.selective.reduce(
		(total, group) => total + group.size,
		0,
	);
	const includedOptionalSize = includedOptional.reduce(
		(total, group) => total + group.size,
		0,
	);
	const allOptionalSize = bins.optional.reduce(
		(total, group) => total + group.size,
		0,
	);
	const selectedPayload =
		bins.requiredSize + selectiveSize + includedOptionalSize;

	const pageSize =
		scraped?.hddSpaceAfterInstallBytes ?? scraped?.originalSizeBytes ?? null;
	if (pageSize && pageSize > 0) {
		const fullPayload = bins.requiredSize + selectiveSize + allOptionalSize;
		const selectedShare =
			fullPayload > 0 ? selectedPayload / fullPayload : 1;
		return Math.max(Math.round(pageSize * selectedShare), 2 ** 30);
	}

	return Math.max(Math.round(selectedPayload * 2.5), 2 ** 30);
}
