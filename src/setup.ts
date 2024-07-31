import fs from 'fs';
import { JSDOM } from 'jsdom';
import axios from 'axios';
import { setTimeout } from 'timers/promises';

const games: { name: string, url: string }[] = [];
for (let page = 0; page < 94; page++) {
  console.log(`Scraping page ${page}`);
  const response = await axios.get(`https://fitgirl-repacks.site/all-my-repacks-a-z/?lcp_page0=${page}#lcp_instance_0`)
  const dom = new JSDOM(response.data);
  const document = dom.window.document;
  const entryContent = document.querySelector('.entry-content');

  if (entryContent) {
      // Find all the game links within the entry-content div, excluding lcp_paginator
      const gameLinks = entryContent.querySelectorAll('a[href*="fitgirl-repacks.site"]:not(.lcp_paginator a)');

      // Extract the names and URLs of the games
      gameLinks.forEach(link => {
        games.push({ name: link.textContent!!.trim(), url: link.getAttribute('href')!! });
      });
      console.log(`-- Found ${gameLinks.length} games on page ${page}`);
  } else {
    console.log('No entry-content div found');
  }

  // please be generous, don't spam the server. This is the most expensive part of the script
  await setTimeout(750);
  console.log('-- Scraped page');
}

fs.writeFileSync('fit-scrape-search.json', JSON.stringify(games, null, 2));
console.log('Results have been saved to fit-scrape-search.json');