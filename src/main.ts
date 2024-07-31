import OGIAddon, { SearchResult } from "ogi-addon";
import fs from "fs";
import * as JsSearch from "js-search";
import axios from "axios";
import { JSDOM } from "jsdom";
import crypto from 'crypto'
import { exec } from "child_process";

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
  coverImage: string
}
const scrapedGames: Game[] = JSON.parse(fs.readFileSync('fit-scrape-search.json', 'utf-8'));
const search = new JsSearch.Search('name');
search.addIndex('name');
search.addDocuments(scrapedGames);

addon.on('configure', (config) => config)
addon.on('search', (query, event) => {
  event.defer();
  new Promise<void>(async (resolve) => {
    let results: GameInfo[] = []
    let amountOfScrapes = 0;
    for (const gameObj of search.search(query)) {
      if (amountOfScrapes >= 5) {
        break;
      }
      const game = gameObj as Game;
      // get the hash of the game name
      const gameMetaData = await scrapeGameMetadata(game, generateHash(game.name));
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
      }
    });
    event.resolve(searchResults);
    resolve();
  });
  
});

addon.on('setup', ({ path, type, name, usedRealDebrid, multiPartFiles }, event) => {
  event.defer();
  event.log("Setting up fitgirl game...");
  // get the path and open setup.exe
  const setupPath = `${path}\\setup.exe`;
  event.log(`Opening setup.exe`);
  exec(setupPath)
  setTimeout(() => {
    event.complete();
  }, 2000);
})
addon.on('connect', () => {
  addon.notify({
    message: 'FatBoy Unpack Ready',
    id: 'fatboy-unpack-connected',
    type: 'info'
  })
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
  document.querySelectorAll('.entry-content').forEach((element: Element) => {
    // Get the company name
    let company = '';
    const companyMatch = element.textContent!!.match(/Companies:\s*(.*?)\s*Languages:/);
    if (companyMatch) {
      company = companyMatch[1].trim();
    }

    // Get the magnet link and torrent file links
    let magnetLink = '';
    let torrentLinks: string[] = [];

    element.querySelectorAll('a').forEach((link: HTMLAnchorElement) => {
      const href = link.href;
      if (href.includes('magnet:?')) {
        magnetLink = href;
      } else if (href.includes('.torrent')) {
        torrentLinks.push(href);
      }
    });

    // Get the cover image
    let coverImage = '';
    const imgElement = element.querySelector('img');
    if (imgElement) {
      coverImage = imgElement.src;
    }
    // Add the data to the array
    data = { name: game.name, company, magnetLink, torrentLinks, coverImage };
  });
  fs.mkdirSync('./repack-data-scrapes', { recursive: true });
  
  fs.writeFileSync(`./repack-data-scrapes/${hash}.json`, JSON.stringify(data, null, 2));
  return data;
}