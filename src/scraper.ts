import fs from 'fs';
import { JSDOM } from 'jsdom';
import axios from 'axios';
import { setTimeout } from 'timers/promises';
import { CustomTask } from 'ogi-addon';
export async function shouldScrape(scrapingInterval: number): Promise<boolean> {
  const timeSinceScrape = fs.existsSync('time-since-scrape.txt') ? parseInt(fs.readFileSync('time-since-scrape.txt', 'utf-8')) : 0;
  if (Date.now() - timeSinceScrape < scrapingInterval) {
    console.log('Scrape is still valid, skipping scraping');
    return false;
  }
  console.log('Scrape is invalid, scraping');
  return true;
}

function replaceFancyASCII(text: string) {
  return text
    .replace(/[‘’‛’′`]/g, "'")    // Replace fancy apostrophes
    .replace(/[“”„″]/g, '"')    // Replace fancy quotes
    .replace(/[‐‑‒–—―]/g, '-')  // Replace fancy dashes
    .replace(/[•‣∙]/g, '*')     // Replace fancy bullets
    .replace(/[…]/g, '...')     // Replace ellipsis
    .replace(/[‖]/g, '||')      // Replace double vertical line
    .replace(/[‗]/g, '_')       // Replace double underscore
    .replace(/[⁄∕]/g, '/')      // Replace fancy slashes
    .replace(/[†‡]/g, '+')      // Replace daggers
    .replace(/[‰]/g, '%');      // Replace per mille sign
}

export async function findPageCount() {
  const pageFinder = await axios.get('https://fitgirl-repacks.site/all-my-repacks-a-z/');
  const dom = new JSDOM(pageFinder.data);
  const document = dom.window.document;
  const paginator = document.querySelector('ul.lcp_paginator');

  if (paginator) {
    const pageLinks = paginator.querySelectorAll<HTMLAnchorElement>('a[title]');

    if (pageLinks.length >= 2) {
      const lastPageLink = pageLinks[pageLinks.length - 2];
      const lastPageNumber = lastPageLink.title;
      return Number(lastPageNumber);
    } else {
      console.log('Could not find enough page links to determine the last page.');
    }
  } else {
    console.log('Pagination container element not found on the page.');
  }
  return 0;
}
export async function scrapeHer(task: CustomTask) {
  const games: { name: string, url: string }[] = [];
  const pageCount = await findPageCount();
  if (pageCount === 0 || isNaN(pageCount)) {
    task.log('No page count found, major error. Please report this to the developer.');
    task.finish();
    return;
  }
  task.log(`Found ${pageCount} pages to scrape`);
  // 0-100
  task.setProgress(0);
  for (let page = 0; page <= pageCount; page++) {
    task.setProgress(page / pageCount * 100);
    const response = await axios.get(`https://fitgirl-repacks.site/all-my-repacks-a-z/?lcp_page0=${page}#lcp_instance_0`)
    const dom = new JSDOM(response.data);
    const document = dom.window.document;
    const entryContent = document.querySelector('.entry-content');

    if (entryContent) {
        // Find all the game links within the entry-content div, excluding lcp_paginator
        const gameLinks = entryContent.querySelectorAll('a[href*="fitgirl-repacks.site"]:not(.lcp_paginator a)');

        // Extract the names and URLs of the games
        gameLinks.forEach(link => {
          games.push({ name: replaceFancyASCII(link.textContent!!.trim()), url: link.getAttribute('href')!! });
        });
        task.log(`-- Found ${gameLinks.length} games on page ${page}`);
    } else {
      task.log('No entry-content div found');
    }

    // please be generous, don't spam the server. This is the most expensive part of the script
    console.log('-- Scraped page');
  }

  fs.writeFileSync('fit-scrape-search.json', JSON.stringify(games, null, 2));
  fs.writeFileSync('time-since-scrape.txt', Date.now().toString());
  console.log('Results have been saved to fit-scrape-search.json');
}
