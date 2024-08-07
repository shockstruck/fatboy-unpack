import { scrapeHer, shouldScrape } from './scraper';
if (await shouldScrape(7 * 86400000)) {
  await scrapeHer();
}