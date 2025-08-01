import axios from 'axios';
import OGIAddon, { CustomTask } from 'ogi-addon';
import { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

const BROWSER_CONFIG = {
  headless: false,
};

const FITGIRL_DOMAIN = 'fitgirl-repacks.site';

interface DDOSGuardHeaders {
  cookieString: string;
  userAgent: string;
  timestamp: number;
  url: string;
}

const HEADERS_FILE = 'ddosguard.json';
const HEADERS_EXPIRY_HOURS = 24; // Headers expire after 24 hours

// Function to save headers to file
function saveHeaders(headers: DDOSGuardHeaders, task: CustomTask): void {
  try {
    const filePath = path.join(process.cwd(), HEADERS_FILE);
    fs.writeFileSync(filePath, JSON.stringify(headers, null, 2));
    task.log(`Headers saved to ${HEADERS_FILE}`);
  } catch (error: any) {
    task.log(`Error saving headers: ${error.message || error}`);
  }
}

// Function to load headers from file
function loadHeaders(task: CustomTask): DDOSGuardHeaders | null {
  try {
    const filePath = path.join(process.cwd(), HEADERS_FILE);
    
    if (!fs.existsSync(filePath)) {
      task.log('No saved headers found');
      return null;
    }
    
    const data = fs.readFileSync(filePath, 'utf8');
    const headers: DDOSGuardHeaders = JSON.parse(data);
    
    // Check if headers are expired
    const now = Date.now();
    const expiryTime = headers.timestamp + (HEADERS_EXPIRY_HOURS * 60 * 60 * 1000);
    
    if (now > expiryTime) {
      task.log('Saved headers have expired');
      return null;
    }
    
    task.log('Loaded saved headers from file');
    return headers;
  } catch (error: any) {
    task.log(`Error loading headers: ${error.message || error}`);
    return null;
  }
}

// Utility function to safely perform page operations
async function safePageOperation<T>(page: Page, operation: () => Promise<T>, task: CustomTask, operationName: string): Promise<T | null> {
  try {
    if (page.isClosed()) {
      task.log(`Page was closed during ${operationName}`);
      return null;
    }
    return await operation();
  } catch (error: any) {
    if (error.message?.includes('execution context was destroyed')) {
      task.log(`Execution context was destroyed during ${operationName}`);
    } else {
      task.log(`Error during ${operationName}: ${error.message || error}`);
    }
    return null;
  }
}

async function extractCookiesAndUserAgent(browser: Browser, page: Page, task: CustomTask): Promise<{ cookieString: string; userAgent: string } | null> {
  try {
    const cookies = await browser.cookies();
    const cookiesFitGirl = cookies.filter(cookie => cookie.domain.includes(FITGIRL_DOMAIN));
    if (!cookiesFitGirl.length) {
      task.log('DDOS Guard cookie not found');
      return null;
    }
    
    const userAgent = await safePageOperation(
      page, 
      () => page.evaluate(() => navigator.userAgent),
      task,
      'user agent extraction'
    );
    
    if (!userAgent) {
      return null;
    }
    
    const cookieString = cookiesFitGirl.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    return { cookieString, userAgent };
  } catch (error: any) {
    if (error.message?.includes('execution context was destroyed')) {
      task.log('Execution context was destroyed while extracting cookies and user agent');
    } else {
      task.log(`Error extracting cookies and user agent: ${error.message || error}`);
    }
    return null;
  }
}

async function testDDOSGuardSolution(url: string, cookieString: string, userAgent: string, task: CustomTask): Promise<boolean> {
  try {
    task.log('Testing DDoS guard solution...');
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': userAgent,
        'Cookie': cookieString
      },
      timeout: 10000, // 10 second timeout
      validateStatus: (status) => true // Don't throw on any status code
    });
    
    if (response.status === 200) {
      // Additional check: make sure we're not getting a DDoS guard page
      if (response.data && typeof response.data === 'string') {
        const isDDoSGuardPage = response.data.includes('ddg-captcha') || 
                               response.data.includes('DDoS') || 
                               response.data.includes('Cloudflare');
        
        if (isDDoSGuardPage) {
          task.log('DDoS guard page still present despite 200 status');
          return false;
        }
      }
      
      task.log('DDoS guard successfully solved and validated');
      return true;
    } else {
      task.log(`DDoS guard may not be fully solved, status: ${response.status}`);
      return false;
    }
  } catch (error: any) {
    if (error.response) {
      task.log(`Error testing DDoS guard solution: HTTP ${error.response.status}`);
    } else if (error.code === 'ECONNABORTED') {
      task.log('Error testing DDoS guard solution: Request timeout');
    } else {
      task.log(`Error testing DDoS guard solution: ${error.message || error}`);
    }
    return false;
  }
}

async function handleDDOSGuardSolution(browser: Browser, page: Page, url: string, task: CustomTask): Promise<string | null> {
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      task.log(`Attempting to solve DDoS guard (attempt ${retryCount + 1}/${maxRetries})`);
      
      // Wait until the page title contains "FitGirl Repacks"
      await new Promise<void>(async (resolve) => {
        let resolved = false;

        async function checkForFitGirlContent() {
          const content = await safePageOperation(
            page,
            async () => {
              const content = await page.content();
              // wait for the page to be loaded or at least the body to be loaded
              await page.waitForSelector('body');
              return content;
            },
            task,
            'content check'
          );
          
          if (content && content.includes("FitGirl Repacks")) {
            if (!resolved) {
              resolved = true;
              task.log('FitGirl Repacks content found');
              console.log('FitGirl Repacks content found');
              resolve();
            }
          }
        }

        // Listen for navigation events and check title
        page.on('framenavigated', async () => {
          await checkForFitGirlContent();
        });

        // Poll every 500ms in case navigation doesn't fire
        const checkInterval = setInterval(async () => {
          if (resolved) {
            clearInterval(checkInterval);
            return;
          }
          await checkForFitGirlContent();
        }, 2000);

        // Timeout after 3 minutes
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearInterval(checkInterval);
            resolve();
          }
        }, 180000);
      });

      console.log('FitGirl Repacks content found! Resolving user agent and cookies...');

      const cookieData = await extractCookiesAndUserAgent(browser, page, task);
      if (!cookieData) {
        task.log('Failed to extract cookies and user agent');
        retryCount++;
        if (retryCount < maxRetries) {
          task.log('Retrying...');
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
          continue;
        }
        return null;
      }

      // Test the solution before closing the browser
      const isResolved = await testDDOSGuardSolution(url, cookieData.cookieString, cookieData.userAgent, task);
      
      if (isResolved) {
        task.log('DDoS guard solution validated successfully');
        
        // Save the headers for future use
        const headersToSave: DDOSGuardHeaders = {
          cookieString: cookieData.cookieString,
          userAgent: cookieData.userAgent,
          timestamp: Date.now(),
          url: url
        };
        saveHeaders(headersToSave, task);
        
        try {
          await browser.close();
        } catch (e: any) {
          task.log(`Error closing browser: ${e.message || e}`);
        }
        return cookieData.cookieString;
      } else {
        task.log(`DDoS guard solution validation failed (attempt ${retryCount + 1}/${maxRetries})`);
        retryCount++;
        
        if (retryCount < maxRetries) {
          task.log('Retrying DDoS guard solution...');
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Try refreshing the page and waiting again
          await safePageOperation(
            page,
            async () => {
              await page.reload();
              await page.waitForNetworkIdle();
            },
            task,
            'page reload'
          );
          continue;
        } else {
          task.log('All retry attempts exhausted for DDoS guard solution');
          try {
            await browser.close();
          } catch (e: any) {
            task.log(`Error closing browser: ${e.message || e}`);
          }
          return null;
        }
      }
    } catch (error: any) {
      if (error.message?.includes('execution context was destroyed')) {
        task.log(`Execution context was destroyed during DDoS guard solution attempt ${retryCount + 1}`);
      } else {
        task.log(`Error during DDoS guard solution attempt ${retryCount + 1}: ${error.message || error}`);
      }
      retryCount++;
      
      if (retryCount < maxRetries) {
        task.log('Retrying due to error...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      } else {
        task.log('All retry attempts exhausted due to errors');
        try {
          await browser.close();
        } catch (e: any) {
          task.log(`Error closing browser: ${e.message || e}`);
        }
        return null;
      }
    }
  }
  
  try {
    await browser.close();
  } catch (e: any) {
    task.log(`Error closing browser: ${e.message || e}`);
  }
  return null;
}

export async function solveDDOSGuard(addon: OGIAddon, url: string, task: CustomTask): Promise<string | null> {
  // First, try to load saved headers
  const savedHeaders = loadHeaders(task);
  if (savedHeaders && savedHeaders.url === url) {
    task.log('Testing saved headers...');
    const isValid = await testDDOSGuardSolution(url, savedHeaders.cookieString, savedHeaders.userAgent, task);
    if (isValid) {
      task.log('Using saved headers successfully');
      return savedHeaders.cookieString;
    } else {
      task.log('Saved headers are no longer valid');
    }
  }

  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    let browser: Browser | null = null;
    let page: Page | null = null;
    
    try {
      task.log(`Initializing DDoS guard solving (attempt ${retryCount + 1}/${maxRetries})`);
      
      // use the stealth plugin to make the browser more stealthy and seem human
      puppeteer.use(stealth());
      browser = await puppeteer.launch({
        headless: true
      });
      page = await browser.newPage();
      await page.goto(url);
      
      // Wait until the network is idle
      await page.waitForNetworkIdle();

      // Check if there is an element with id 'ddg-captcha' indicating a captcha needs to be solved
      // run the captcha check for at least 10 seconds
      let ddosGuardPresent = false;
      let timeout = 0;
      while (timeout < 10000 && page) {
        const captchaElement = await safePageOperation(
          page!,
          () => page!.$('#ddg-captcha'),
          task,
          'captcha element check'
        );
        
        if (captchaElement !== null) {
          ddosGuardPresent = true;
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        timeout += 100;
      }
      
      if (ddosGuardPresent) {
        task.log('DDOS Guard captcha detected, switching to visible mode for manual solving...');
        
        // Close the headless browser and relaunch in visible mode
        try {
          await browser.close();
        } catch (e: any) {
          task.log(`Error closing headless browser: ${e.message || e}`);
        }
        
        const visibleBrowser = await puppeteer.launch({
          headless: false
        });
        const visiblePage = await visibleBrowser.newPage();

        await visiblePage.goto(url);
        addon.notify({
          id: 'fatboy-unpack-ddos-guard',
          message: 'Please solve the DDOS Guard captcha in the opened browser window',
          type: 'info'
        })
        task.log('Please solve the DDOS Guard captcha in the opened browser window...');
        
        const result = await handleDDOSGuardSolution(visibleBrowser, visiblePage, url, task);
        if (result) {
          return result;
        }
      } else {
        task.log('No DDOS Guard captcha detected, continuing with DDoS guard solution...');
        const result = await handleDDOSGuardSolution(browser, page, url, task);
        if (result) {
          return result;
        }
      }
      
      // If we get here, the solution failed
      retryCount++;
      if (retryCount < maxRetries) {
        task.log(`DDoS guard solving failed, retrying in 5 seconds... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      
    } catch (error: any) {
      if (error.message?.includes('execution context was destroyed')) {
        task.log(`Execution context was destroyed during DDoS guard initialization attempt ${retryCount + 1}`);
      } else {
        task.log(`Error during DDoS guard initialization attempt ${retryCount + 1}: ${error.message || error}`);
      }
      retryCount++;
      
      // Clean up browser if it exists
      if (browser) {
        try {
          await browser.close();
        } catch (e: any) {
          task.log(`Error closing browser during cleanup: ${e.message || e}`);
        }
      }
      
      if (retryCount < maxRetries) {
        task.log('Retrying DDoS guard initialization due to error...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
    }
  }
  
  task.log('All DDoS guard solving attempts exhausted');
  return null;
}