import puppeteer from "puppeteer";
import { connect } from "puppeteer-real-browser";

export async function catchDownload(
  url: string,
  selector: string,
): Promise<string | null> {
  const ffLog = (msg: string) => console.log(`[FuckingFast] ${msg}`);

  let browser: Awaited<ReturnType<typeof connect>>["browser"] | undefined;
  try {
    ffLog(`launching browser for ${url}`);
    const connection = await connect({
      headless: false,
      turnstile: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      customConfig: { chromePath: puppeteer.executablePath() },
      connectOption: { defaultViewport: null },
    });
    browser = connection.browser;
    const page = connection.page;

    ffLog(`navigating to ${url}`);
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    ffLog(
      `goto finished: status=${response?.status() ?? "none"} finalUrl=${page.url()}`,
    );

    await page.waitForSelector("body");
    ffLog(`page ready: title="${await page.title()}"`);

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

    const downloadPath = await button.evaluate((element) =>
      element.getAttribute("hx-post"),
    );
    if (!downloadPath) {
      ffLog(`button does not have an hx-post endpoint`);
      return null;
    }

    ffLog(`requesting direct url from ${downloadPath}`);
    await page.waitForFunction(
      "Boolean(window.turnstileToken || document.querySelector('[name=cf-turnstile-response]')?.value)",
      { timeout: 30000 },
    );
    const downloadResponse = await page.evaluate(
      async (path): Promise<{ status: number; downloadURL: string | null }> => {
        const turnstileWindow = window as Window & {
          turnstileToken?: string;
        };
        const turnstileInput = document.querySelector<HTMLInputElement>(
          '[name="cf-turnstile-response"]',
        );
        const token = turnstileWindow.turnstileToken ?? turnstileInput?.value;
        const response = await fetch(path, {
          method: "POST",
          headers: {
            "HX-Request": "true",
            "HX-Target": "",
            "HX-Current-URL": location.href,
          },
          body: new URLSearchParams({
            "cf-turnstile-response": token ?? "",
          }),
        });
        return {
          status: response.status,
          downloadURL: response.headers.get("HX-Redirect"),
        };
      },
      downloadPath,
    );

    const downloadURL = downloadResponse.downloadURL;
    if (!downloadURL) {
      ffLog(
        `download response did not include hx-redirect: status=${downloadResponse.status}`,
      );
      return null;
    }

    ffLog(`captured download url: ${downloadURL}`);
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
