import OGIAddon, { ConfigurationBuilder, SearchResult } from "ogi-addon";
import fs from "fs";
import * as JsSearch from "js-search";
import axios from "axios";
import { JSDOM } from "jsdom";
import crypto from 'crypto'
import { exec, execSync, spawn } from "child_process";
import { scrapeHer } from "./scraper";
import { join } from "path";

const addon = new OGIAddon({
  author: "Nat3z",
  description: "A FitGirl Repack scraper.",
  name: "Fatboy Unpack",
  id: "fatboy-unpack",
  repository: "https://github.com/Nat3z/fatboy-unpack",
  version: "1.0.0"
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

async function getSteamApps(): Promise<{ appid: string, name: string }[]> {
  if (fs.existsSync('steam-apps.json')) {
    const steamApps: { timeSinceUpdate: number, data: {appid: string, name: string}[] } = JSON.parse(fs.readFileSync('steam-apps.json', 'utf-8'));
    if (Date.now() - steamApps.timeSinceUpdate < 86400000) { //24 hours
      return steamApps.data;
    }
  }
  const response = await axios.get('https://api.steampowered.com/ISteamApps/GetAppList/v0002/?key=STEAMKEY&format=json') 
  const steamApps = response.data.applist.apps;
  fs.writeFileSync('steam-apps.json', JSON.stringify({ timeSinceUpdate: Date.now(), data: steamApps }, null, 2));
  return steamApps
}

const scrapedGames: Game[] = JSON.parse(fs.readFileSync('fit-scrape-search.json', 'utf-8'));
const steamApps: { appid: string, name: string }[] = await getSteamApps();
const steamAppMatcher = new JsSearch.Search('appid');
steamAppMatcher.addIndex('appid');
steamAppMatcher.addDocuments(steamApps);

const search = new JsSearch.Search('name');
search.addIndex('name');
search.addDocuments(scrapedGames);

addon.on('configure', (config) => config)

addon.on('search', ({ text, type }, event) => {
  event.defer();
  if (type !== 'steamapp') {
    event.resolve([]);
    return;
  }
  new Promise<void>(async (resolve) => {
    let results: GameInfo[] = []
    let amountOfScrapes = 0;
    for (const gameObj of steamAppMatcher.search(text)) {
      if (amountOfScrapes >= 5) {
        break;
      }
      const game = gameObj as { appid: string, name: string };
      // now get the game metadata from fitgirl
      const fitgirl = search.search(game.name) as Game[];
      if (fitgirl.length === 0) {
        continue
      }
      addon.notify({
        message: `Found variant from FitGirl: ${fitgirl[0].name}`,
        id: 'fatboy-unpack-game-found',
        type: 'info'
      });
      const gameMetaData = await scrapeGameMetadata(fitgirl[0], generateHash(game.name));
      addon.notify({
        message: `Found game: ${game.name} with appid: ${text}`,
        id: 'fatboy-unpack-game-found',
        type: 'info'
      })
      if (gameMetaData) {
        results.push(gameMetaData);
      }
      amountOfScrapes++;
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
        steamAppID: parseInt(text)
      }
    });
    event.resolve(searchResults);
    resolve();
  });
  
});

addon.on('setup', ({ path, type, name, usedRealDebrid, steamAppID, multiPartFiles }, event) => {
  event.defer();
  event.log("Setting up fitgirl game...");
  // get the path and open setup.exe
  new Promise<void>(async (resolve) => {
    const screen = new ConfigurationBuilder()
      .addBooleanOption(option => option.setName("automate").setDisplayName("Automate Setup").setDescription("Automate the setup process").setDefaultValue(true))
      .addStringOption(option => option.setName("installDir").setDisplayName("Installation Directory").setDescription("The directory where the game will be installed").setInputType('folder'))

    if (fs.existsSync(join(path, 'fg-optional-bonus-content.bin'))) {
      screen.addBooleanOption(option => option.setName("addBonus").setDisplayName("Add Bonus Content").setDescription("Add the optional bonus content to the installation"))
    }
    const input = await event.askForInput("FitGirl Repacks", "Setup your FitGirl Repack", screen)

    const setupPath = join(path, 'setup.exe');
    const installDir = input.installDir as string;
    const addBonus = input.addBonus as boolean ?? false;
    const setupINF = makeSetupINF(installDir, addBonus);
    if (input.automate) {
      
      fs.writeFileSync(`${path}\\fatboy-setup.inf`, setupINF);
      event.log(`Setup INI file created at ${path}\\fatboy-setup.inf`);
      event.log(`Opening setup.exe with INI file`);
      execSync(`${setupPath} /SILENT /LOADINF=fatboy-setup.inf`, { cwd: path });
    }
    else {
      event.log(`Opening setup.exe`);
      execSync(`${setupPath}`, { cwd: path });
    }

    const gameExecutable = await event.askForInput("FitGirl Repacks", "Help us help you.", new ConfigurationBuilder()
      .addStringOption(option => option
        .setName('workingDir')
        .setDisplayName('Working Directory')
        .setDescription('Go to the directory: ' + (installDir ?? ' (where you installed it)') + ' and select the working directory. (usually where the game executable is located)')
        .setInputType('folder')
      )
      .addStringOption(option => option
        .setName("gameExecutable")
        .setDisplayName("Game Executable")
        .setDescription("Go to the directory: " + (installDir ?? ' (where you installed it)') + " and select the game executable.")
        .setInputType('file')
      )
    )

    // exec(setupPath)
    event.resolve({
      capsuleImage: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppID}/library_600x900_2x.jpg`,
      cwd: gameExecutable.workingDir as string,
      launchExecutable: gameExecutable.gameExecutable as string,
      name: name,
      steamAppID: steamAppID,
      version: '1.0.0',
      launchArguments: ''
    })
      resolve();
  });

})
addon.on('connect', () => {
  addon.notify({
    message: 'FatBoy Unpack Ready',
    id: 'fatboy-unpack-connected',
    type: 'info'
  });
  if (!fs.existsSync('fit-scrape-search.json')) {
    scrapeHer(0);
    return;
  }
  scrapeHer(7 * 86400000);
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
  const response = await axios.get(game.url); 
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
    const downloadMirrorsHeader = Array.from(element.querySelectorAll('h3')).find(h3 => h3.textContent!!.includes('Download Mirrors (Torrent)'));
    if (downloadMirrorsHeader) {
      const links = downloadMirrorsHeader.nextElementSibling!!.querySelectorAll('a[href*="magnet:?"]');
      console.log(links)
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

async function getRealGame(titleId: string): Promise<string | undefined> {
  const response = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${titleId}`);
  if (!response.data[titleId].success) {
    return undefined;
  }
  if (response.data[titleId].data.type === 'game') {
    return titleId;
  }

  if (response.data[titleId].data.type === 'dlc' || response.data[titleId].data.type === 'dlc_sub' || response.data[titleId].data.type === 'music' || response.data[titleId].data.type === 'video' || response.data[titleId].data.type === 'episode') { 
    return response.data[titleId].data.fullgame.appid;
  }
  if (response.data[titleId].data.type === 'demo') {
    return response.data[titleId].data.fullgame.appid;
  }
}
async function matchSteamAppID(title: string): Promise<string | undefined> {
  const steamAppId = steamAppMatcher.search(title);
  console.log(steamAppId);
  if (steamAppId.length === 0) {
    return undefined;
  }
  return getRealGame((steamAppId[0] as any).appid);
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