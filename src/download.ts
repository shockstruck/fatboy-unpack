import puppeteer from "puppeteer-extra";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";

async function closePopupPages(
  browser: Awaited<ReturnType<typeof puppeteer.launch>>,
  mainPage: Awaited<ReturnType<typeof browser.newPage>>,
): Promise<void> {
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      if (p && p !== mainPage) {
        try {
          await p.close();
        } catch {}
      }
    }
    await mainPage.bringToFront();
  } catch {
    // ignore (browser/page may be closing)
  }
}

export async function catchDownload(
  url: string,
  selector: string,
): Promise<string | null> {
  const ffLog = (msg: string) => console.log(`[FuckingFast] ${msg}`);

  puppeteer.use(AdblockerPlugin());

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    ffLog(`launching browser for ${url}`);
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    ffLog(`navigating to ${url}`);
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    ffLog(
      `goto finished: status=${response?.status() ?? "none"} finalUrl=${page.url()}`,
    );

    await page
      .waitForNetworkIdle({ idleTime: 500, timeout: 15000 })
      .catch((err) => {
        ffLog(`waitForNetworkIdle timed out or failed: ${err}`);
      });
    await page.waitForSelector("body");
    ffLog(`page ready: title="${await page.title()}"`);

    // Close any popups that opened during load (steamrip-addon pattern).
    await new Promise((r) => setTimeout(r, 150));
    await closePopupPages(browser, page);
    ffLog(`closed popup tabs after load, main tab: ${page.url()}`);

    const button = await page.$(selector);
    if (!button) {
      const buttons = await page.$$eval("button, a", (els) =>
        els.slice(0, 20).map((el) => ({
          tag: el.tagName,
          class: el.className,
          text: (el.textContent ?? "").trim().slice(0, 80),
        })),
      );
      ffLog(`button not found for selector "${selector}"`);
      ffLog(`first buttons/links on page: ${JSON.stringify(buttons)}`);
      return null;
    }
    ffLog(`found button for selector "${selector}"`);

    const downloadURL = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (result: string | null, reason: string) => {
        if (settled) return;
        settled = true;
        ffLog(reason);
        resolve(result);
      };

      void (async () => {
        const cdp = await browser!.target().createCDPSession();
        await cdp.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: "/tmp",
          eventsEnabled: true,
        });
        ffLog("CDP download behavior enabled");

        cdp.on("Browser.downloadWillBegin", (event) => {
          ffLog(
            `downloadWillBegin: url=${event.url ?? "(empty)"} guid=${event.guid}`,
          );
          if (!event.url) {
            finish(null, "download began without url");
            return;
          }
          cdp
            .send("Browser.cancelDownload", { guid: event.guid })
            .then(() =>
              finish(event.url, `captured download url: ${event.url}`),
            )
            .catch((err) => finish(null, `cancelDownload failed: ${err}`));
        });

        cdp.on("Browser.downloadProgress", (event) => {
          ffLog(
            `downloadProgress: guid=${event.guid} state=${event.state} received=${event.receivedBytes}/${event.totalBytes}`,
          );
        });

        let clickTries = 0;
        while (clickTries < 10 && !settled) {
          clickTries++;
          ffLog(`clicking download button (${clickTries}/10)`);
          await button.click();
          await new Promise((r) => setTimeout(r, 150));
          await closePopupPages(browser!, page);
          ffLog(
            `closed popup tabs after click ${clickTries}, main tab: ${page.url()}`,
          );

          if (!settled) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        setTimeout(() => {
          finish(null, "timed out after 30s waiting for downloadWillBegin");
        }, 30000);
      })().catch((err) => {
        finish(null, `CDP/setup error: ${err}`);
      });
    });

    return downloadURL;
  } catch (err) {
    ffLog(`catchDownload error: ${err}`);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      ffLog("browser closed");
    }
  }
}
