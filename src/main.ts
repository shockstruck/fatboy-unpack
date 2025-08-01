import OGIAddon, { ConfigurationBuilder, SearchResult, SearchTool } from "ogi-addon";
import fs from "fs";
import axios from "axios";
import { JSDOM } from "jsdom";
import crypto from 'crypto'
import { exec, execSync, spawn } from "child_process";
import { scrapeHer, shouldScrape, axiosGetWithDDOSGuard, updateCookieString, getCookieString } from "./scraper";
import { join } from "path";
import { solveDDOSGuard } from "./ddosguard";

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

type Game = {
  name: string,
  url: string,
}
type GameInfo = {
  name: string,
  company: string,
  magnetLink: string,
  torrentLinks: string[],
  coverImage: string,
  steamAppId?: string
}

let scrapedGames: Game[] | undefined = undefined;
const search = new SearchTool<Game>([], ['name'], {
  threshold: 0.1,
  includeScore: true
})

addon.on('configure', (config) => config
  .addStringOption(option => option.setName('whereToWine').setDefaultValue('flatpak').setDisplayName('Wine Source').setDescription('Where to go to if wine is needed.').setAllowedValues(['flatpak', 'wine']))
)

addon.on('search', ({ appID, storefront }, event) => {
  if (scrapedGames === undefined) {
    event.defer();
    addon.notify({
      message: 'FatBoy: There are no scraped games available. Try restarting the addon server or wait for the scrape to complete.',
      id: 'fatboy-unpack-scraping',
      type: 'info'
    });
    event.resolve([]);
    return;
  }

  addon.notify({
    message: 'Searching for game...',
    id: 'fatboy-unpack-searching',
    type: 'info'
  })
  event.defer(async () => {
    console.log('should be deferred')
    let results: GameInfo[] = [];
    addon.notify({
      message: `Getting game details... ${appID} ${storefront}`,
      id: 'fatboy-unpack-getting-game-details',
      type: 'info'
    })
    const game = await addon.getAppDetails(appID, storefront);
    if (!game) {
      event.resolve([]);
      return;
    }
    // now get the game metadata from fitgirl
    const fitGame = search.search(game.name);
    if (fitGame.length === 0) {
      event.resolve([]);
      return;
    }
    
    addon.notify({
      message: `Found variant from FitGirl: ${fitGame[0].name}`,
      id: 'fatboy-unpack-game-found',
      type: 'info'
    });
    const gameMetaData = await scrapeGameMetadata(fitGame[0], generateHash(game.name));

    if (gameMetaData) {
      results.push(gameMetaData);
    }

    // turn GameInfo into search result
    const searchResults: SearchResult[] = results.map((game: GameInfo) => {
      return {
        coverURL: game.coverImage,
        description: game.company ? `Made By: ${game.company}` : 'No company information available',
        downloadSize: 0,
        downloadType: 'magnet',
        name: game.name,
        downloadURL: game.magnetLink,
        filename: generateHash(game.name),
        appID: appID,
        storefront: 'steam',
      }
    });
    event.resolve(searchResults);
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
addon.on('setup', ({ path, type, name, usedRealDebrid, appID, storefront, multiPartFiles }, event) => {
  const wineSource = addon.config.getStringValue('whereToWine') || 'flatpak';
  event.defer();
  event.log("Setting up fitgirl game...");
  // get the path and open setup.exe

  // check if wine is instaleld in that source by running the help command check if it fails 

  new Promise<void>(async (resolve) => {
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
        .addStringOption(option => option.setName("installDir").setDisplayName("Installation Directory").setDescription("The directory where the game will be installed").setInputType('folder'))

      if (fs.existsSync(join(path, 'fg-optional-bonus-content.bin'))) {
        screen.addBooleanOption(option => option.setName("addBonus").setDisplayName("Add Bonus Content").setDescription("Add the optional bonus content to the installation"))
      }
      input = await event.askForInput("FitGirl Repacks", "Setup your FitGirl Repack", screen) as {
        automate: boolean,
        installDir: string,
        addBonus: boolean
      }
    } else {
      input = {
        automate: false,
        installDir: path,
        addBonus: false
      }
    }

    const setupPath = join(path, 'setup.exe');
    let installDir = input.installDir as string;
    const addBonus = input.addBonus as boolean ?? false;
    const setupINF = makeSetupINF(installDir, addBonus);

    // add a directory to the path called 'INSTALL HERE'
    if (process.platform === 'linux') {
      fs.mkdirSync(join(path, 'INSTALL HERE'), { recursive: true });

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
          await new Promise<string>((resolve, reject) => {
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
            }, 'sudo', ['-S', 'flatpak', 'override', 'org.winehq.Wine', '--filesystem=' + path]);
            process.stdin?.write(`${rootPassword}\n`);
            process.stdin?.end();
          });
          event.log(`Overrided Wine to allow access to the installation directory using "${path}"`);
        } catch (err) {
          event.fail("Failed to apply flatpak override. Please check your permissions.");
          return;
        }
      }
    }
    if (input.automate) {
      fs.writeFileSync(`${path}\\fatboy-setup.inf`, setupINF);
      event.log(`Setup INI file created at ${path}\\fatboy-setup.inf`);
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
          let acknowledge = await event.askForInput("FitGirl Repacks", "Before we launch the setup, it's important to know that when you are selecting the destination location, you MUST use the Z drive (even if you are using an SD Card). If you are using an SD Card, go to Z:\\" + path.replaceAll('/', '\\') + "\\INSTALL HERE", new ConfigurationBuilder()
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
        installDir = path;
        const installHereDir = join(path, 'INSTALL HERE');
        
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


    const gameExecutable = await event.askForInput("FitGirl Repacks", "Help us help you.", new ConfigurationBuilder()
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
    )

    // exec(setupPath)
    event.resolve({
      cwd: gameExecutable.workingDir as string,
      launchExecutable: gameExecutable.gameExecutable as string,
      version: '1.0.0',
      launchArguments: ''
    })
    resolve();
  });

})

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
        task.finish();
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
      task.finish();
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
    task.finish();
    resolve();
  });
});

function generateHash(str: string) {
  return crypto.createHash('sha1').
    update(str).
    digest('hex');
}

async function scrapeGameMetadata(game: Game, hash: string) {
  if (fs.existsSync(`./repack-data-scrapes/${hash}.json`)) {
    return JSON.parse(fs.readFileSync(`./repack-data-scrapes/${hash}.json`, 'utf-8')) as GameInfo;
  }
  const response = await axiosGetWithDDOSGuard(addon, game.url, {});
  const dom = new JSDOM(response.data);
  const document = dom.window.document;

  // Initialize an array to hold the data
  let data: GameInfo | undefined = undefined;

  // Loop through each element with class 'entry-content'
  document.querySelectorAll('.entry-content').forEach(element => {
    // Get the company name
    let company = '';
    const companyMatch = element.textContent!!.match(/Companies:\s*(.*?)\s*Languages:/);
    if (companyMatch) {
      company = companyMatch[1].trim();
    }

    // Get the cover image
    let coverImage = '';
    const imgElement = element.querySelector('img');
    if (imgElement) {
      coverImage = imgElement.src;
    }

    // Get the magnet link under "Download Mirrors (Torrent)" from 1337x
    let magnetLink = '';
    const downloadMirrorsHeader = Array.from(element.querySelectorAll('h3')).find(h3 => (h3.textContent!!.includes('Download Mirrors (Torrent)') || h3.textContent!!.includes('Download Mirrors')) && !h3.textContent!!.includes('Direct Links'));
    if (downloadMirrorsHeader) {
      const links = downloadMirrorsHeader.nextElementSibling!!.querySelectorAll('a[href*="magnet:?"]');
      links.forEach(link => {
        const previous = link.parentElement!!.querySelector("a[target=_blank]")
        if (previous && previous.textContent === "1337x") {
          magnetLink = link.getAttribute('href')!!;
        }
      });
    }
    data = {
      company,
      coverImage,
      magnetLink,
      name: game.name,
      torrentLinks: []
    }
  });

  fs.mkdirSync('./repack-data-scrapes', { recursive: true });

  fs.writeFileSync(`./repack-data-scrapes/${hash}.json`, JSON.stringify(data, null, 2));
  return data;
}

function extractSimpleName(input: string) {
  // Regular expression to match the game name
  const regex = /^(.+?)([:\-–])/;
  const match = input.match(regex);
  return match ? match[1].trim() : null;
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
