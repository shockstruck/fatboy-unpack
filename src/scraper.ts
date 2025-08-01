import fs from 'fs';
import { JSDOM } from 'jsdom';
import axios from 'axios';
import { setTimeout } from 'timers/promises';
import OGIAddon, { CustomTask } from 'ogi-addon';
import { solveDDOSGuard } from './ddosguard';

// Global variable to store the cookie string
let axiosCookieString = '';

// Function to update the cookie string
export function updateCookieString(cookieString: string) {
  axiosCookieString = cookieString;
}

// Function to get the current cookie string
export function getCookieString(): string {
  return axiosCookieString;
}

// Wrapper function for axios.get that handles 403 errors with DDoS guard
export async function axiosGetWithDDOSGuard(addon: OGIAddon, url: string, options: { headers?: Record<string, string> } = {}, task?: CustomTask): Promise<any> {
  const maxRetries = 3;
  let retryCount = 0;
  let lastError: any = null;
  
  while (retryCount < maxRetries) {
    try {
      const response = await axios.get(url, {
        headers: {
          'Cookie': axiosCookieString,
          ...options.headers
        }
      });
      
      // If this is a retry after DDoS guard solving, notify success
      if (retryCount > 0) {
        addon.notify({
          id: 'fatboy-unpack-request-success',
          message: `Request successful after DDoS guard solving`,
          type: 'success'
        });
      }
      
      return response;
    } catch (error: any) {
      lastError = error;
      
      if (error.response?.status === 403 && retryCount < maxRetries - 1) {
        retryCount++;
        console.log(`Received 403 error, attempting to solve DDoS guard (attempt ${retryCount}/${maxRetries})`);
        
        if (task) {
          task.log(`Solving DDoS guard (attempt ${retryCount}/${maxRetries})`);
        }
        
        // Send notification about starting DDoS guard solving
        addon.notify({
          id: 'fatboy-unpack-ddos-guard-solving',
          message: `DDoS guard detected. Attempting to solve (attempt ${retryCount}/${maxRetries})...`,
          type: 'info'
        });
        
        // Create a temporary task if none provided
        let blockTask = await addon.task();
        
        const cookieString = await solveDDOSGuard(addon, url, blockTask);
        if (cookieString) {
          // Update the cookie string
          updateCookieString(cookieString);
          console.log('DDoS guard solved, retrying request...');
          
          // Send notification about successful DDoS guard solving
          addon.notify({
            id: 'fatboy-unpack-ddos-guard-solved',
            message: `DDoS guard successfully solved on attempt ${retryCount}. Retrying request...`,
            type: 'success'
          });
          
          continue;
        } else {
          console.log('Failed to solve DDoS guard');
          // Send notification about DDoS guard failure
          addon.notify({
            id: 'fatboy-unpack-ddos-guard-failed',
            message: `Failed to solve DDoS guard after ${retryCount} attempts. The site may be experiencing issues.`,
            type: 'error'
          });
        }
      }
      
      // If it's not a 403 or we've exhausted retries, throw the error
      throw error;
    }
  }
  
  // If we get here, all retries have been exhausted
  const errorMessage = `Failed to make request after ${maxRetries} attempts`;
  const detailedMessage = lastError?.response?.status 
    ? `${errorMessage}. Last error: HTTP ${lastError.response.status}`
    : lastError?.message 
    ? `${errorMessage}. Last error: ${lastError.message}`
    : errorMessage;
  
  // Categorize the error for better notification
  let notificationMessage = `Request to ${new URL(url).hostname} failed`;
  let notificationId = 'fatboy-unpack-request-failed';
  
  if (lastError?.response?.status === 403) {
    notificationMessage = `DDoS guard could not be solved for ${new URL(url).hostname}. The site may be experiencing issues.`;
    notificationId = 'fatboy-unpack-ddos-guard-permanent-failure';
  } else if (lastError?.response?.status >= 500) {
    notificationMessage = `Server error (${lastError.response.status}) from ${new URL(url).hostname}. The site may be down.`;
    notificationId = 'fatboy-unpack-server-error';
  } else if (lastError?.code === 'ECONNABORTED' || lastError?.code === 'ETIMEDOUT') {
    notificationMessage = `Connection timeout to ${new URL(url).hostname}. Check your internet connection.`;
    notificationId = 'fatboy-unpack-connection-timeout';
  } else if (lastError?.code === 'ENOTFOUND') {
    notificationMessage = `Could not reach ${new URL(url).hostname}. Check your internet connection.`;
    notificationId = 'fatboy-unpack-connection-error';
  }
  
  // Send notification about the failure
  addon.notify({
    id: notificationId,
    message: notificationMessage,
    type: 'error'
  });
  
  if (task) {
    task.log(`Request failed: ${detailedMessage}`);
  }
  
  throw new Error(detailedMessage);
}

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

export async function findPageCount(addon: OGIAddon) {
  const pageFinder = await axiosGetWithDDOSGuard(addon, 'https://fitgirl-repacks.site/all-my-repacks-a-z/', {});
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
export async function scrapeHer(addon: OGIAddon, task: CustomTask) {
  const games: { name: string, url: string }[] = [];
  const pageCount = await findPageCount(addon);
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
    const response = await axiosGetWithDDOSGuard(addon, `https://fitgirl-repacks.site/all-my-repacks-a-z/?lcp_page0=${page}#lcp_instance_0`, {}, task);
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
