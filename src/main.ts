import OGIAddon, { ConfigurationBuilder, SearchResult, SearchTool } from "ogi-addon";
import fs from "fs";
import axios from "axios";
import { JSDOM } from "jsdom";
import crypto from 'crypto'
import { exec, execSync, spawn } from "child_process";
import { scrapeHer, shouldScrape, axiosGetWithDDOSGuard, updateCookieString, getCookieString } from "./scraper";
import { dirname, join } from "path";
import { solveDDOSGuard } from "./ddosguard";
import { catchDownload } from "./download";
import { findBestGameMatch, Game } from "./string-similarity";

// Cookie string is now managed in scraper.ts
const addon = new OGIAddon({
  author: "Fat-Addons",
  description: "A FitGirl Repack scraper.",
  name: "Fatboy Unpack",
  id: "fatboy-unpack",
  repository: "https://github.com/Fat-Addons/fatboy-unpack",
  version: "1.0.0",
  storefronts: ["steam"]
});

type GameInfo = {
  name: string,
  company: string,
  magnetLink: string,
  torrentLinks: string[],
  coverImage: string,
  steamAppId?: string,
  directLinks: { service: string, links: { name: string, url: string }[] }[]
}

let scrapedGames: Game[] | undefined = undefined;
const makeSearch = () => {
  return new SearchTool<Game>([], ['name'], {
    threshold: 0.1,
    includeScore: true
  })
}
let search = makeSearch();

addon.on('configure', (config) => config
  .addStringOption(option => option.setName('whereToWine').setDefaultValue('flatpak').setDisplayName('Wine Source').setDescription('Where to go to if wine is needed.').setAllowedValues(['flatpak', 'wine']))
  .addActionOption(option => option.setName('re-run-scrapes').setDisplayName('Re-run Scrapes').setDescription('Re-run the scrapes for FitGirl Repacks').setButtonText('Run').setTaskName('re-run-scrapes'))
)

addon.on('search', (data, event) => {
  const { appID, storefront, for: searchType } = data;
  const noResolution: Parameters<typeof event.resolve>[0] = [
    {
      downloadType: 'request',
      name: 'Local Files',
      manifest: {
        service: 'local'
      }
    },
  ];
  if (searchType === 'task') {
    event.defer();
    event.resolve(noResolution);
    return;
  }

  if (scrapedGames === undefined) {
    event.defer();
    addon.notify({
      message: 'FatBoy: There are no scraped games available. Try restarting the addon server or wait for the scrape to complete.',
      id: 'fatboy-unpack-scraping',
      type: 'info'
    });
    event.resolve(noResolution);
    return;
  }

  event.defer(async () => {
    console.log('should be deferred')
    const noResolutionAndReset: Parameters<typeof event.resolve>[0] = [
      {
        downloadType: 'request',
        name: 'Local Files',
        manifest: {
          service: 'local'
        }
      },
      {
        downloadType: 'task',
        name: 'Update Scrapes - Refresh FitGirl Repacks',
        taskName: 're-run-scrapes',
      }
    ];
    const game = await addon.getAppDetails(appID, storefront);
    if (!game) {
      event.resolve(noResolutionAndReset);
      return;
    }
    // now get the game metadata from fitgirl
    const fitGame = findBestGameMatch(game.name, scrapedGames!, search);
    
    if (!fitGame) {
      event.resolve(noResolutionAndReset);
      return;
    }
    
    const gameMetaData = await scrapeGameMetadata(fitGame, generateHash(game.name));
    let results: Parameters<typeof event.resolve>[0] = noResolution;
    
    // direct service - FuckingFast 
    console.log('direct services', gameMetaData.directLinks);
    if (gameMetaData.directLinks && gameMetaData.directLinks.some(directLink => directLink.service === 'FuckingFast')) {
      const links = gameMetaData.directLinks.find(directLink => directLink.service === 'FuckingFast')?.links ?? [];
      results.push({
        name: 'FuckingFast | ' + gameMetaData.name,
        downloadType: 'request',
        manifest: {
          service: 'FuckingFast',
          links: links.map(link => ({
            name: link.name,
            url: link.url
          }))
        }
      })
    }

    // magnet link - 1337x
    if (gameMetaData.magnetLink) {
      results.push({
        name: '1337x | ' + gameMetaData.name,
        downloadType: 'magnet',
        downloadURL: gameMetaData.magnetLink,
        filename: generateHash(game.name),
      })
    }
    event.resolve([
      // sort so that the local files entry (downloadType === 'request' && manifest.service === 'local) is always last, and others retain order. 
      ...results.filter(r => r.downloadType !== 'request' || r.manifest?.service !== 'local'),
      ...results.filter(r => r.downloadType === 'request' && r.manifest?.service === 'local')
    ]);
  });


});

function spawnAndHook(options: {
  stdout?: (data: string) => void,
  stderr?: (data: string) => void,
  onClose?: (code: number) => void,
  onError?: (err: Error) => void,
  rootPassword?: string,
  cwd?: string,
}, command: Parameters<typeof spawn>[0], args: Parameters<typeof spawn>[1]) {
  const spawnOptions = options.cwd ? { cwd: options.cwd } : {};
  console.log('running: ' + command.replace(options.rootPassword ?? '<rootPassword_insertion_ogi_addon_system>', '<root password>') + ' ' + args.join(' '));
  const childProcess = spawn(command, args, spawnOptions);
  let stdout = '';
  let stderr = '';
  
  if (childProcess.stdout) {
    childProcess.stdout.on('data', (data: Buffer) => {
      const dataStr = data.toString();
      stdout += dataStr;
      if (options.stdout) {
        options.stdout(dataStr.replace(options.rootPassword ?? '<rootPassword_insertion_ogi_addon_system>', '<root password>'));
      }
    });
  }
  
  if (childProcess.stderr) {
    childProcess.stderr.on('data', (data: Buffer) => {
      const dataStr = data.toString();
      stderr += dataStr;
      if (options.stderr) {
        options.stderr(dataStr);
      }
    });
  }
  
  if (options.onClose) {
    childProcess.on('close', (code: number) => {
      options.onClose?.(code);
    });
  }
  
  if (options.onError) {
    childProcess.on('error', (err: Error) => {
      options.onError?.(err);
    });
  }
  
  return {
    process: childProcess,
    stdout,
    stderr,
    stdin: childProcess.stdin
  }
}
addon.on('setup', ({ path, type, name, usedRealDebrid, appID, storefront, multiPartFiles, manifest }, event) => {
  const wineSource = addon.config.getStringValue('whereToWine') || 'flatpak';
  event.defer();
  event.log("Setting up fitgirl game...");
  // check if wine is instaleld in that source by running the help command check if it fails 

  new Promise<void>(async (resolve) => {
  // this was a direct download, we need to multipart unrar these files
    event.log(type);
    if (manifest && manifest.service === 'local') {
      path = manifest.pathOfSetupExe as string;
      event.log('Using local setup.exe file: ' + path);
    }
    else if (type === 'direct' && Array.isArray(multiPartFiles) && multiPartFiles.length > 0) {
      event.log('Unraring downloaded contents... This may take a while depending on the size of the files, amount of files, and speed of your computer. Please be patient.');
      if (process.platform === 'win32') {
        console.log(path);
        await new Promise<void>((resolve) => {
          const unrar = spawn('C:\\Program Files\\7-Zip\\7z.exe', ['x', join(path, multiPartFiles[0].name)], { stdio: 'inherit', cwd: path });
          unrar.stdout?.on('data', (data: Buffer) => {
            event.log(data.toString());
          });
          unrar.stderr?.on('data', (data) => {
            event.log(data.toString());
          });
          unrar.on('close', (code) => {
            event.log(`Unrar completed with code ${code}`);
            resolve();
          });
        });
      } else {
        for (const part of multiPartFiles) {
          const filePath = join(path, part.name);
          await new Promise<void>((resolve) => {
            const unrar = spawn('unrar', ['x', filePath, path, '-kb', '-y'], { stdio: 'inherit' });
            unrar.stdout?.on('data', (data) => {
              event.log(data.toString());
            });
            unrar.stderr?.on('data', (data) => {
              event.log(data.toString());
            });
            unrar.on('close', (code) => {
              event.log(`Unrar completed for ${part.name} with code ${code}`);
              resolve();
            });
          });
        }
      }
      // now delete the rar files
      event.log('Deleting rar files..');
      for (const part of multiPartFiles) {
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

    let hasWine = process.platform === 'win32' ? true : false;
    const homeDir = process.env.HOME || process.env.USERPROFILE || '~/';
    const winePrefixDir = join(homeDir, '.wine-fitgirl');
    if (wineSource === 'flatpak' && process.platform !== 'win32') {
      try {
        execSync(`flatpak run org.winehq.Wine --help`);
        hasWine = true;
        event.log('Wine is installed in flatpak.');
      } catch (err) {
        event.log('Wine is not installed in flatpak. Installing it...');
        // install wine in flatpak
        // then test it one more time
        try {
          // Automatically press 2 for user-level install by echoing '2' into flatpak install
          event.log('Installing wine in flatpak...');
          await new Promise<void>((resolve) => {
            spawnAndHook({
              stdout: (data: string) => {
                event.log('- ' + data);
              },
              stderr: (data: string) => {
                console.log('- ' + data);
              },
              onClose: (code: number) => {
                if (code !== 0) {
                  console.error('FLATPAK ERROR: Exit code ' + code);
                  event.fail('Error installing wine in flatpak. Please install it manually and try again.');
                  return;
                }
                event.log('Wine installed in flatpak.');
                resolve();
              },
              onError: (err: Error) => {
                console.error('FLATPAK ERROR:', err);
                event.fail('Error installing wine in flatpak. Please install it manually and try again.');
              },
            }, 'flatpak', [
              'install', '--system', '-y', 'flathub', 'org.winehq.Wine/x86_64/stable-24.08'
            ]);
          });
          execSync(`flatpak run org.winehq.Wine --help`);
          event.log('Wine is installed in flatpak.');
          // create a prefix for fitgirl
          // Create the Wine prefix directory in the user's home directory as .wine-fitgirl 
          fs.mkdirSync(winePrefixDir, { recursive: true });
        } catch (err) {
          console.error(err);
          event.fail('Wine is not installed in flatpak. Please install it in flatpak and try again. We tried to install it for you, but it failed. Please try again.');
          console.log('no flat');
          return;
        }
        hasWine = true;
      }
    }
    else if (wineSource === 'wine' && process.platform !== 'win32') {
      try {
        execSync(`wine --help`);
        hasWine = true;
        event.log('Wine is installed in PATH.');
      } catch (err) {
        event.fail('Wine is not installed in PATH. We recommend using the flatpak version of wine for a smoother experience.');
        return;
      }
    }

    if (!hasWine) {
      event.fail('Wine is not installed in PATH. We recommend using the flatpak version of wine for a smoother experience.');
      return;
    }

    let input: {
      automate: boolean,
      installDir: string,
      addBonus: boolean
    } | undefined = undefined
    if (process.platform !== 'linux') {
      const screen = new ConfigurationBuilder()
        .addBooleanOption(option => option.setName("automate").setDisplayName("Automate Setup").setDescription("Automate the setup process (If on linux, we recommend doing it by yourself.)").setDefaultValue(true))
        .addStringOption(option => option.setName("installDir").setDisplayName("Game Installation Directory").setDescription("Choose where you want to install the game (this should be different from where the setup files are located)").setDefaultValue(path).setInputType('folder'))

      if (fs.existsSync(join(path, 'fg-optional-bonus-content.bin'))) {
        screen.addBooleanOption(option => option.setName("addBonus").setDisplayName("Add Bonus Content").setDescription("Add the optional bonus content to the installation"))
      }
      input = await event.askForInput("FitGirl Repacks", "Setup your FitGirl Repack", screen) as {
        automate: boolean,
        installDir: string,
        addBonus: boolean
      }
    } else {
      // On Linux, we need to get the installation directory from the user
      // The 'path' parameter already contains the setup.exe location
      if (!fs.existsSync(join(path, 'setup.exe'))) {
        event.fail('Error: setup.exe not found in the download directory. Please ensure the download is complete.');
        return;
      }
      
      const screen = new ConfigurationBuilder()
        .addStringOption(option => option.setName("installDir").setDisplayName("Game Installation Directory").setDescription("Choose where you want to install the game (this should be different from where the setup files are located)").setDefaultValue(path).setInputType('folder'))

      const byUser = await event.askForInput("FitGirl Repacks", "Setup your FitGirl Repack", screen) as {
        installDir: string
      }
      
      input = {
        automate: false,
        installDir: byUser.installDir,
        addBonus: false
      }
    }

    if (input.installDir) {
      // check if the installDir is a valid path, then check if there is content inside the installDir
      if (!fs.existsSync(input.installDir)) {
        event.fail('Error: installDir is not a valid path. Please enter a valid path.');
        return;
      }
      if (fs.readdirSync(input.installDir).length !== 0 && path !== input.installDir) {
        input.installDir = join(input.installDir, name);
        event.log(`installDir is not empty and path is not the same as installDir, so we will append the game name to the installDir to prevent deleting entire folder contents.`);
      }
    }

    const setupPath = join(path, 'setup.exe');
    
    let installDir = input.installDir as string;
    const addBonus = input.addBonus as boolean ?? false;
    const setupINF = makeSetupINF(installDir, addBonus);

    // add a directory to the path called 'INSTALL HERE'
    if (process.platform === 'linux') {
      fs.mkdirSync(join(installDir, 'INSTALL HERE'), { recursive: true });

      let rootPassword: string | undefined;
      let sudoSuccess = false;

      // Only needed for flatpak, but we want to check sudo password validity
      if (wineSource === 'flatpak') {
        while (!sudoSuccess) {
          rootPassword = (await event.askForInput(
            "FitGirl Repacks",
            sudoSuccess === false && rootPassword !== undefined
              ? "Incorrect password. Please enter your root password again"
              : "Please enter your root password",
            new ConfigurationBuilder()
              .addStringOption(option =>
                option
                  .setName('rootPassword')
                  .setDisplayName('Root Password')
                  .setDescription('We need this in order to apply a patch so Wine can launch. We don\'t do anything else after that.')
                  .setInputType('password')
              )
          )).rootPassword as string;

          try {
            // Try to run a harmless sudo command to check password
            execSync(`echo -e "${rootPassword}\n" | sudo -S -k true`, { stdio: 'ignore' });
            // If no error, password is correct
            sudoSuccess = true;
          } catch (err) {
            sudoSuccess = false;
          }
        }

        // Now apply the flatpak override
        try {
          // Helper function to apply flatpak override for a given directory
          async function applyFlatpakOverride(dir: string, rootPassword: string) {
            return new Promise<string>((resolve, reject) => {
              const process = spawnAndHook({
                stdout: (data: string) => {
                  event.log(data);
                },
                stderr: (data: string) => {
                  event.log(data);
                },
                onClose: (code: number) => {
                  if (code !== 0) {
                    reject(new Error(`Process exited with code ${code}`));
                  } else {
                    resolve('Process completed successfully');
                  }
                },
                onError: (err: Error) => {
                  reject(err);
                },
                rootPassword: rootPassword
              }, 'sudo', [
                '-S',
                'flatpak',
                'override',
                'org.winehq.Wine',
                `--filesystem=${dir}`
              ]);
              process.stdin?.write(`${rootPassword}\n`);
              process.stdin?.end();
            });
          }

          // Apply flatpak override for both installDir and path
          if (!rootPassword) {
            event.fail('Error: rootPassword is not set. Please enter your root password again.');
            return;
          }
          await applyFlatpakOverride(installDir, rootPassword);
          await applyFlatpakOverride(path, rootPassword);

          event.log(`Overrided Wine to allow access to the installation directory using "${installDir}" and "${path}"`);
        } catch (err) {
          event.fail("Failed to apply flatpak override. Please check your permissions.");
          return;
        }
      }
    }
    if (input.automate) {
      const setupINFPath = join(path, 'fatboy-setup.inf');
      fs.writeFileSync(setupINFPath, setupINF);
      event.log(`Setup INI file created at ${setupINFPath}`);
      event.log(`Opening setup.exe with INI file`);
      if (process.platform === 'win32') {
        execSync(`"${setupPath}" /SILENT /LOADINF=fatboy-setup.inf`, { cwd: path });
      }
      else if (process.platform === 'linux') {
        if (wineSource === 'flatpak') {
          await new Promise<string>((resolve, reject) => {
            const stdout = execSync('flatpak --env="WINEPREFIX=' + winePrefixDir + '" run org.winehq.Wine setup.exe /SILENT /LOADINF=fatboy-setup.inf', { cwd: path });
            resolve(stdout.toString());
          });
        }
        else if (wineSource === 'wine') {
          await new Promise<string>((resolve, reject) => {
            const { stdout } = spawnAndHook({
              cwd: path,
              onClose: (code: number) => {
                resolve(stdout);
              },
              onError: (err: Error) => {
                reject(err);
              }
            }, 'wine', [setupPath, '/SILENT', '/LOADINF=fatboy-setup.inf']);
          });
        }
      }
    }
    else {
      event.log(`Opening setup.exe`);
      if (process.platform === 'win32') {
        try {
          execSync(`"${setupPath}"`, { cwd: path });
        } catch (err) {
          event.fail('Error opening setup.exe. It\'s possible that Windows quarantined the file. Please try again.');
          return;
        }
      }
      else if (process.platform === 'linux') {
        let acknowledged = false
        while (!acknowledged) {
          let acknowledge = await event.askForInput("FitGirl Repacks", "Before we launch the setup, it's important to know that when you are selecting the destination location, you MUST use the Z drive (even if you are using an SD Card). If you are using an SD Card, go to Z:\\" + installDir.replaceAll('/', '\\') + "\\INSTALL HERE", new ConfigurationBuilder()
            .addBooleanOption(option => option
              .setDisplayName('I Understand')
              .setName('understood')
              .setDescription('I understand that I need to use the Z drive in order to properly install my repack.')
              .setDefaultValue(false)
            )  
          );
          if (acknowledge.understood === true) {
            acknowledge = await event.askForInput("FitGirl Repacks", "When selecting the destination location, select the folder with the name \"INSTALL HERE\" so we can smoothly move the contents of the folder to the path.", new ConfigurationBuilder()
              .addBooleanOption(option => option
                .setDisplayName('I Understand')
                .setName('understood')
                .setDescription('I understand that I need to select the folder with the name \"INSTALL HERE\" so FatBoy can smoothly move the contents of the folder to the path.')
                .setDefaultValue(false)
              )
            );
            if (acknowledge.understood === true) {
              acknowledged = true;
            }
          }
        }
        event.log(`Acknowledged`);
        let forceStop = false;
        if (wineSource === 'flatpak') {
          try {
            await new Promise<string>((resolve, reject) =>
              spawnAndHook({
                cwd: path,
                stdout: (data: string) => {
                  event.log(data);
                },
                stderr: (data: string) => {
                  event.log(data);
                },
                onClose: (code: number) => {
                  console.log('onClose', code);
                  if (code === 0) {
                    resolve('Process completed successfully');
                  } else {
                    reject(new Error(`Process exited with code ${code}`));
                  }
                },
                onError: (err: Error) => {
                  reject(err);
                }
              }, 'flatpak', ['--env=WINEPREFIX=' + winePrefixDir, 'run', 'org.winehq.Wine', 'setup.exe'])
            );
          } catch (err) {
            event.log(`Error opening setup.exe: ${err}`);
            event.fail('Error opening setup.exe. Check if wine is installed in "' + wineSource + '" and if it is, try again.');
            forceStop = true;
          }
        }
        else if (wineSource === 'wine') {
          try {
            await new Promise<string>((resolve, reject) => {
              const result = execSync('WINEPREFIX="' + winePrefixDir + '" wine setup.exe', { cwd: path });
              resolve(result.toString());
            }) 
          } catch (err) {
            event.log(`Error opening setup.exe: ${err}`);
            event.fail('Error opening setup.exe. Check if wine is installed in "' + wineSource + '" and if it is, try again.');
            forceStop = true;
          }
        }
        if (forceStop) {
          return;
        }

        // ask if the user has finished the setup process
        const finishedSetup = await event.askForInput("FitGirl Repacks", "Have you finished the setup process for " + name + "?", new ConfigurationBuilder()
          .addBooleanOption(option => option
            .setDisplayName('Finished Setup')
            .setName('finishedSetup')
            .setDescription('Have you finished the setup process?')
            .setDefaultValue(false)
          )
        );
        if (finishedSetup.finishedSetup === false) {
          event.fail('Error: you have not finished the setup process. Please finish the setup process and try again.');
          return;
        }

        // delete all other files and folders in the path except the 'INSTALL HERE' directory        
        event.log(`Deleting all other files and folders in the path except the 'INSTALL HERE' directory`);
        fs.readdirSync(path).forEach(file => {
          if (file !== 'INSTALL HERE') {
            const fullPath = join(path, file);
            const stat = fs.lstatSync(fullPath);
            if (stat.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
          }
        });
        event.log('Deleted.');

        // move the contents of 'INSTALL HERE' directory to the path
        const installHereDir = join(installDir, 'INSTALL HERE');
        
        if (fs.existsSync(installHereDir)) {
          // Check if there's content in INSTALL HERE
          const installHereFiles = fs.readdirSync(installHereDir);
          
          if (installHereFiles.length > 0) {
            // If there's a single nested folder, move its contents up
            if (installHereFiles.length === 1 && fs.statSync(join(installHereDir, installHereFiles[0])).isDirectory()) {
              const nestedDir = join(installHereDir, installHereFiles[0]);
              const nestedFiles = fs.readdirSync(nestedDir);
              
              // Move all files from the nested directory to the parent path
              for (const file of nestedFiles) {
                const sourcePath = join(nestedDir, file);
                const destPath = join(installDir, file);
                fs.renameSync(sourcePath, destPath);
              }
              event.log(`Moved contents from nested directory '${installHereFiles[0]}' to ${installDir}`);
            } else {
              // Move all files from INSTALL HERE to the parent path
              for (const file of installHereFiles) {
                const sourcePath = join(installHereDir, file);
                const destPath = join(installDir, file);
                fs.renameSync(sourcePath, destPath);
              }
              event.log(`Moved contents from 'INSTALL HERE' directory to ${installDir}`);
            }

            // then, delete the 'INSTALL HERE' directory
            fs.rmSync(installHereDir, { recursive: true, force: true });
          }
          
          // Remove the now-empty INSTALL HERE directory
          fs.rmSync(installHereDir, { recursive: true, force: true });
        }
      }
    }

    // Function to find executable files in a directory
    function findExecutableFiles(directory: string): string[] {
      if (!fs.existsSync(directory)) {
        return [];
      }
      
      const files = fs.readdirSync(directory);
      const executableExtensions = ['.exe', '.bat', '.cmd'];
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
        /^steam_/i
      ];
      
      return files.filter(file => {
        const filePath = join(directory, file);
        const stats = fs.statSync(filePath);
        
        // Skip directories
        if (stats.isDirectory()) {
          return false;
        }
        
        // Check if it has an executable extension
        const hasExeExtension = executableExtensions.some(ext => 
          file.toLowerCase().endsWith(ext)
        );
        
        if (!hasExeExtension) {
          return false;
        }
        
        // Exclude unwanted files
        const shouldExclude = excludePatterns.some(pattern => 
          pattern.test(file)
        );
        
        return !shouldExclude;
      }).map(file => join(directory, file));
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
        gameExecutable: potentialExecutables[0]
      };
    } else {
      // Ask user to select manually
      if (potentialExecutables.length === 0) {
        event.log('No executable files found automatically. Please select manually.');
      } else {
        event.log(`Found ${potentialExecutables.length} potential executables. Please select manually.`);
      }
      
      gameExecutable = await event.askForInput("FitGirl Repacks", "Help us help you.", new ConfigurationBuilder()
        .addStringOption(option => option
          .setName('workingDir')
          .setDisplayName('Working Directory')
          .setDescription('Go to the directory: ' + (installDir ?? '(where you installed it)') + ' and select the working directory. (usually where the game executable is located)')
          .setInputType('folder')
          .setDefaultValue(installDir)
        )
        .addStringOption(option => option
          .setName("gameExecutable")
          .setDisplayName("Game Executable")
          .setDescription("Go to the directory: " + (installDir ?? '(where you installed it)') + " and select the game executable.")
          .setInputType('file')
        )
      ) as { workingDir: string; gameExecutable: string };
    }

    // exec(setupPath)
    // check if the working directory contains unity. if it does, then no need to run any dependencies
    // check the files in the working directory folder and if one of the names contains "unityplayer.dll" then no need to run any dependencies
    const workingDir = gameExecutable.workingDir as string;
    const files = fs.readdirSync(workingDir);
    let hasUnity = false;
    if (files.some(file => file.toLowerCase().includes('unityplayer.dll'))) {
      hasUnity = true;
    }
    
    let redistributables: { name: string, path: string }[] = [];

    if (process.platform === 'linux') {
      // ask if the user wants to install the redistributables
      const installRedistributables = await event.askForInput("FitGirl Repacks", "Do you want to install the redistributables? This will automatically run winetricks and create a Wine prefix for you.", new ConfigurationBuilder()
        .addBooleanOption(option => option
          .setName('installRedistributables')
          .setDisplayName('Install Redistributables')
          .setDescription('Install the redistributables needed for the game.')
          .setDefaultValue(true)
        )
      ) as { installRedistributables: boolean };
      if (installRedistributables.installRedistributables) {
        // most redistributables above are what's needed for most games.
        redistributables.push({
          name: 'vcrun2015',
          path: 'winetricks'
        });
        redistributables.push({
          name: 'vcrun2019',
          path: 'winetricks'
        });
        redistributables.push({
          name: 'dotnet48',
          path: 'winetricks'
        });
      }
    }

    // write a file steam_appid.txt in the installDir with the steamAppId if it doesn't exist
    if (!fs.existsSync(join(installDir, 'steam_appid.txt'))) {
      fs.writeFileSync(join(installDir, 'steam_appid.txt'), appID.toString());
    }

    // if there's a "winmm.dll" in the executable path, we need to add it to winedlls
    let winedlls: string[] = [];
    for (const dllToAdd of [ 'winmm', 'steam_api64', 'steam_api', 'OnlineFix64']) {
      if (fs.existsSync(join(dirname(gameExecutable.gameExecutable as string), dllToAdd + '.dll'))) {
        winedlls.push(dllToAdd.toLowerCase());
      }
    }
    let appDetails = await addon.getAppDetails(appID, storefront);
    let version = appDetails?.latestVersion ?? '1.0';
    event.resolve({
      cwd: gameExecutable.workingDir as string,
      launchExecutable: gameExecutable.gameExecutable as string,
      version,
      launchArguments: process.platform === 'linux' ? ((winedlls.length > 0 ? 'WINEDLLOVERRIDES="' + winedlls.join(',') + '=n,b"' : '') + ' %command%').trim() : '%command%',
      redistributables
    })
    resolve();
  });

});

addon.on('request-dl', (appID, info, event) => {
  event.defer(async () => {
    if (!info.manifest) {
      event.fail('No manifest found');
      return;
    }
    if (info.manifest.service === 'FuckingFast') {
      const links = info.manifest.links;
      let foundLinks: string[] = [];
      for (const link of links) {
        let tries = 0;
        while (tries < 3) {
          try {
            const downloadURL = await catchDownload(link.url, '.link-button.gay-button');
            if (downloadURL) {
              foundLinks.push(downloadURL);
              addon.notify({
                message: 'Found link (' + (links.indexOf(link) + 1) + '/' + links.length + ') for ' + info.name,
                id: 'fatboy-unpack-download-link-found',
                type: 'success'
              });
              break;
            }
          } catch (err) {
            console.error('Error downloading from FuckingFast', err);
          }
          tries++;
        }

        if (tries === 3) {
          event.fail('Failed to find download link from FuckingFast');
          return;
        }
      }
      if (foundLinks.length === 0) {
        event.fail('No links found');
        return;
      }
      event.resolve({
        name: 'FuckingFast | ' + info.name,
        downloadType: 'direct',
        files: foundLinks.map((link, ind) => ({
          name: 'part' + ind + '.rar',
          downloadURL: link
        }))
      });
    }
    else if (info.manifest.service === 'local') {
      // ask the user to select the setup.exe file
      const setupExe = await event.askForInput("FitGirl Repacks", "Select the setup.exe file", new ConfigurationBuilder()
        .addStringOption(option => option
          .setName('setupExe')
          .setDisplayName('Setup.exe')
          .setDescription('Select the setup.exe file in your repack directory')
          .setInputType('file')
        )
      ) as { setupExe: string };
      const pathOfSetupExe = dirname(setupExe.setupExe);
      event.resolve({
        name: 'Local Files | ' + info.name,
        downloadType: 'empty',
        manifest: {
          service: 'local',
          setupExe: setupExe.setupExe,
          pathOfSetupExe: pathOfSetupExe
        }
      });
    }
  });
  
});

addon.onTask('re-run-scrapes', async (task_this) => {
  let task = await addon.task();
  await scrapeHer(addon, task);
  task.complete();

  scrapedGames = JSON.parse(fs.readFileSync('fit-scrape-search.json', 'utf-8'));
  search = makeSearch();
  search.addItems(scrapedGames!!);

  addon.notify({
    message: 'FitGirl Repacks scraped games updated. Reload the Store Page to see FitGirl results. ',
    id: 'fatboy-unpack-scrapes-updated',
    type: 'success'
  });
  task_this.complete();
});

addon.on('exit', () => {
  process.exit(0);
});

addon.on('connect', async () => {
  // detect firstly if we can access fitigrl
  await new Promise<void>(async (resolve) => {
    axios.get('https://fitgirl-repacks.site/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }).then(async (response) => {
      resolve();
    }).catch(async (err) => {
      // solve ddos guard
      let task = await addon.task();
      addon.notify({
        id: 'fatboy-unpack-ddos-guard',
        message: 'Solving DDOS Guard. This may take a while...',
        type: 'info'
      })
      const cookieString = await solveDDOSGuard(addon, 'https://fitgirl-repacks.site/', task);
      if (cookieString) {
        // set the cookie
        updateCookieString(cookieString);
        task.log('DDOS Guard successfully solved');
        task.complete();
        addon.notify({
          id: 'fatboy-unpack-ddos-guard',
          message: 'DDOS Guard successfully solved',
          type: 'success'
        })
        resolve();
      }
    });
  });

  new Promise<void>(async (resolve) => {
    let task = await addon.task();
    task.log('Checking if scrape is valid...');
    if (!fs.existsSync('fit-scrape-search.json')) {
      addon.notify({
        message: 'Scrapes are invalid, scraping FitGirl...',
        id: 'fatboy-unpack-scraping',
        type: 'info'
      });
      task.log('Scraping FitGirl...');
      await scrapeHer(addon, task);
      scrapedGames = JSON.parse(fs.readFileSync('fit-scrape-search.json', 'utf-8'));
      search.addItems(scrapedGames!!);
      task.log('FitGirl Repacks scraped games loaded');
      addon.notify({
        message: 'FatBoy Unpack Ready',
        id: 'fatboy-unpack-connected',
        type: 'success'
      });
      task.complete();
      return;
    } else {
      scrapedGames = JSON.parse(fs.readFileSync('fit-scrape-search.json', 'utf-8'));
      search.addItems(scrapedGames!!);
      task.log('FitGirl Repacks scraped games loaded');
      addon.notify({
        message: 'FatBoy Unpack Ready',
        id: 'fatboy-unpack-connected',
        type: 'success'
      });
    }
    if (await shouldScrape(2 * 86400000)) {
      addon.notify({
        message: 'Updating scrape of FitGirl Repacks...',
        id: 'fatboy-unpack-scraping',
        type: 'info'
      });
      task.log('Scraping FitGirl...');
      await scrapeHer(addon, task);
      scrapedGames = JSON.parse(fs.readFileSync('fit-scrape-search.json', 'utf-8'));
      search.addItems(scrapedGames!!);
      addon.notify({
        message: 'FitGirl Repacks scraped games loaded',
        id: 'fatboy-unpack-scraped',
        type: 'success'
      });
      task.log('Scraping FitGirl...');
    }
    task.complete();
    resolve();
  });
});

function generateHash(str: string) {
  return crypto.createHash('sha1').
    update(str).
    digest('hex');
}

export async function scrapeGameMetadata(game: Game, hash: string): Promise<GameInfo> {
  const cachePath = `./repack-data-scrapes/${hash}.json`;

  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf-8")) as GameInfo;
  }

  const response = await axiosGetWithDDOSGuard(addon, game.url, {});
  const dom = new JSDOM(response.data);
  const document = dom.window.document;

  let data: GameInfo = {
    name: game.name,
    company: "",
    coverImage: "",
    magnetLink: "",
    torrentLinks: [],
    directLinks: [] // now structured by service
  };

  const entry = document.querySelector(".entry-content");
  if (entry) {
    // Company
    const companyMatch = entry.textContent?.match(/Company:\s*(.*?)\s*Languages:/);
    if (companyMatch) data.company = companyMatch[1].trim();

    // Cover image
    const imgElement = entry.querySelector("img");
    if (imgElement) data.coverImage = imgElement.getAttribute("src") ?? "";

    // Torrent magnet link (1337x)
    const torrentHeader = Array.from(entry.querySelectorAll("h3")).find(
      h3 =>
        (h3.textContent?.includes("Download Mirrors (Torrent)") ||
          h3.textContent?.includes("Download Mirrors")) &&
        !h3.textContent?.includes("Direct Links")
    );
    if (torrentHeader) {
      const links = torrentHeader.nextElementSibling?.querySelectorAll('a[href*="magnet:?"]') ?? [];
      links.forEach(link => {
        const previous = link.parentElement?.querySelector("a[target=_blank]");
        if (previous && previous.textContent === "1337x") {
          data.magnetLink = link.getAttribute("href") ?? "";
        }
      });
    }

    // Direct download links (grouped by filehoster)
    const directHeader = Array.from(entry.querySelectorAll("h3")).find(h3 =>
      h3.textContent?.includes("Download Mirrors (Direct Links)")
    );
    console.log('directHeader', directHeader);
    if (directHeader) {
      const hosters = directHeader.nextElementSibling?.nextElementSibling?.querySelectorAll("li");
      console.log('hosters', hosters);
      hosters?.forEach(li => {
        const serviceAnchor = li.querySelector("a[href]");
        if (!serviceAnchor) return;

        const serviceMatch = serviceAnchor.textContent?.match(/Filehoster:\s*(.*)/);
        const service = serviceMatch ? serviceMatch[1].trim() : "Unknown";

        const spoilerContent = li.querySelector(".su-spoiler-content");
        const links: { name: string; url: string }[] = [];

        if (spoilerContent) {
          spoilerContent.querySelectorAll("a[href]").forEach(a => {
            const url = a.getAttribute("href") ?? "";
            if (url.match(/\.(rar|zip|7z|iso|part\d+\.rar)$/i)) {
              links.push({ name: a.textContent?.trim() ?? url, url });
            }
          });
        }

        data.directLinks.push({ service, links });
      });
    }
  }

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
Components=text${addBonus ? ',bonus' : ''}
Tasks=
`
}
