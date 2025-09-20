import puppeteer from 'puppeteer-extra';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import stealth from 'puppeteer-extra-plugin-stealth';
export async function catchDownload(url: string, selector: string): Promise<string | null> {
  puppeteer.use(AdblockerPlugin());
  puppeteer.use(stealth());
  const browser = await puppeteer.launch({
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForNetworkIdle();
  // wait for the page to be loaded or at least the body to be loaded
  await page.waitForSelector('body');

  // get the button that's selector
  const button = await page.$(selector);
  if (!button) {
    console.error('Button not found');
    browser.close();
    return null;
  }

  // now add to cdp a download event listener
  const downloadURL = await new Promise<string | null>(async (resolve) => {
    // Use a Browser-level CDP session and enable events BEFORE triggering the download
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '/tmp',
      eventsEnabled: true,
    });

    cdp.on('Browser.downloadWillBegin', (event) => {
      if (!event.url) {
        console.error('download will begin but no url');
        browser.close();
        resolve(null);
        return;
      }
      console.log('download will begin', event.url);
      cdp.send('Browser.cancelDownload', { guid: event.guid }).then(() => {
        browser.close();
        resolve(event.url);
      });
    });
    
    await button?.click();
    
    setTimeout(() => {
      browser.close();
      resolve(null);
    }, 30000);
  });

  return downloadURL;
}