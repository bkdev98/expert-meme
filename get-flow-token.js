import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const API_PATTERN = /aisandbox-pa\.googleapis\.com/;
const AUTH_DIR = join(homedir(), '.flowkey-auto');
const USER_DATA_DIR = join(AUTH_DIR, 'chrome-profile');
const TOKEN_FILE = join(AUTH_DIR, 'token.txt');

// Ensure directories exist
if (!existsSync(AUTH_DIR)) {
  mkdirSync(AUTH_DIR, { recursive: true });
}

async function getFlowToken() {
  const headless = process.env.HEADLESS === 'true';
  const hasProfile = existsSync(USER_DATA_DIR);

  console.log('Starting browser...');
  console.log(`Mode: ${headless ? 'headless' : 'headed'}`);
  console.log(`Profile: ${hasProfile ? 'found at ' + USER_DATA_DIR : 'will be created'}`);

  // Use persistent context with user data directory
  // This preserves Google login across sessions (cookies, localStorage, indexedDB, etc.)
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    channel: 'chrome', // Use system Chrome instead of bundled Chromium for better Google compatibility
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Get the first page or create one
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  let capturedToken = null;
  let tokenResolve;
  const tokenPromise = new Promise((resolve) => {
    tokenResolve = resolve;
  });

  // Intercept all requests to capture authorization header
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (API_PATTERN.test(url)) {
      const headers = request.headers();
      const authHeader = headers['authorization'];

      if (authHeader && authHeader.startsWith('Bearer ') && !capturedToken) {
        capturedToken = authHeader.replace('Bearer ', '');
        console.log('\n=== TOKEN CAPTURED ===');
        console.log(`From: ${url}`);
        console.log(`Token: ${capturedToken.substring(0, 50)}...`);

        // Save token to file
        writeFileSync(TOKEN_FILE, capturedToken);
        console.log(`Token saved to: ${TOKEN_FILE}`);

        tokenResolve(capturedToken);
      }
    }

    await route.continue();
  });

  console.log(`\nNavigating to ${FLOW_URL}...`);

  try {
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('Initial navigation timeout, continuing...');
  }

  // Wait a moment for redirects
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);

  // Check if we need to log in
  const needsLogin = currentUrl.includes('accounts.google.com') ||
                     currentUrl.includes('/signin') ||
                     currentUrl.includes('authui');

  if (needsLogin) {
    if (headless) {
      console.log('\n=== LOGIN REQUIRED ===');
      console.log('Cannot login in headless mode. Please run without HEADLESS first:');
      console.log('  npm start');
      await context.close();
      process.exit(1);
    }

    console.log('\n=== LOGIN REQUIRED ===');
    console.log('Please log in to your Google account in the browser window.');
    console.log('The script will automatically continue after login.\n');

    // Wait for navigation away from login page
    try {
      await page.waitForURL((url) => {
        const urlStr = url.toString();
        return urlStr.includes('labs.google') && !urlStr.includes('signin');
      }, { timeout: 300000 }); // 5 min timeout for login

      console.log('Login detected! Waiting for page to stabilize...');
      await page.waitForTimeout(3000);

    } catch (e) {
      console.log('Login wait timed out or was interrupted');
    }
  }

  // Now we should be on the Flow page, wait for API calls
  const finalUrl = page.url();
  console.log(`\nOn page: ${finalUrl}`);

  if (!finalUrl.includes('labs.google')) {
    console.log('Not on Google Labs page. Please navigate manually.');
  }

  // Try to trigger API calls if not captured yet
  if (!capturedToken) {
    console.log('\nWaiting for API request to capture token...');

    // Wait for network to settle
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (e) {
      // Continue anyway
    }

    // Try scrolling or clicking to trigger requests
    try {
      await page.evaluate(() => {
        window.scrollBy(0, 100);
      });
      await page.waitForTimeout(2000);
    } catch (e) {
      // Ignore
    }
  }

  // Wait for token with timeout
  if (!capturedToken) {
    console.log('Waiting up to 60 seconds for token...');
    console.log('(The page should make API calls automatically, or try interacting with it)\n');

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(null), 60000);
    });

    await Promise.race([tokenPromise, timeoutPromise]);
  }

  // If still no token in headed mode, wait for user interaction
  if (!capturedToken && !headless) {
    console.log('\nNo automatic API calls detected.');
    console.log('Try clicking around the page to trigger a request.');
    console.log('Waiting up to 5 more minutes...\n');

    const extendedTimeout = new Promise((resolve) => {
      setTimeout(() => resolve(null), 300000);
    });

    await Promise.race([tokenPromise, extendedTimeout]);
  }

  await context.close();

  if (capturedToken) {
    console.log('\n=== SUCCESS ===');
    console.log(`Token file: ${TOKEN_FILE}`);
    console.log(`Profile saved at: ${USER_DATA_DIR}`);
    console.log(`\nTo use this token:`);
    console.log(`  cat ${TOKEN_FILE}`);
    console.log(`  # or`);
    console.log(`  export FLOW_TOKEN=$(cat ${TOKEN_FILE})`);
    return capturedToken;
  } else {
    console.log('\n=== FAILED ===');
    console.log('Could not capture token.');
    if (headless) {
      console.log('Try running without HEADLESS mode: npm start');
    }
    process.exit(1);
  }
}

// Alternative: Connect to existing Chrome with remote debugging
async function connectToExistingChrome(wsEndpoint) {
  console.log(`Connecting to existing Chrome at ${wsEndpoint}...`);

  const browser = await chromium.connectOverCDP(wsEndpoint);
  const contexts = browser.contexts();

  if (contexts.length === 0) {
    console.log('No browser contexts found');
    return null;
  }

  const context = contexts[0];
  const pages = context.pages();

  console.log(`Found ${pages.length} open tabs`);

  // Find Flow tab or create new one
  let flowPage = pages.find(p => p.url().includes('labs.google'));

  if (flowPage) {
    console.log(`Found existing Flow tab: ${flowPage.url()}`);
  } else {
    console.log('No Flow tab found, creating one...');
    flowPage = await context.newPage();
    await flowPage.goto(FLOW_URL);
  }

  let capturedToken = null;

  // Listen for requests on ALL pages
  for (const p of pages) {
    p.on('request', (request) => {
      const url = request.url();
      if (API_PATTERN.test(url)) {
        const headers = request.headers();
        const authHeader = headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ') && !capturedToken) {
          capturedToken = authHeader.replace('Bearer ', '');
          console.log('\n=== TOKEN CAPTURED ===');
          console.log(`From: ${url}`);
          console.log(`Token: ${capturedToken.substring(0, 50)}...`);
          writeFileSync(TOKEN_FILE, capturedToken);
          console.log(`Saved to: ${TOKEN_FILE}`);
        }
      }
    });
  }

  // Also listen on the flow page specifically
  flowPage.on('request', (request) => {
    const url = request.url();
    if (API_PATTERN.test(url)) {
      const headers = request.headers();
      const authHeader = headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ') && !capturedToken) {
        capturedToken = authHeader.replace('Bearer ', '');
        console.log('\n=== TOKEN CAPTURED ===');
        console.log(`From: ${url}`);
        console.log(`Token: ${capturedToken.substring(0, 50)}...`);
        writeFileSync(TOKEN_FILE, capturedToken);
        console.log(`Saved to: ${TOKEN_FILE}`);
      }
    }
  });

  console.log('\nListening for API requests...');
  console.log('Interact with the Flow page to trigger requests.');
  console.log('Press Ctrl+C when done.\n');

  // Keep running
  await new Promise(() => {});
}

// CLI handling
const args = process.argv.slice(2);

if (args[0] === '--connect' && args[1]) {
  connectToExistingChrome(args[1]).catch(console.error);
} else if (args[0] === '--clear') {
  // Clear saved profile
  const { rmSync } = await import('fs');
  if (existsSync(USER_DATA_DIR)) {
    rmSync(USER_DATA_DIR, { recursive: true, force: true });
    console.log('Cleared saved profile at:', USER_DATA_DIR);
  } else {
    console.log('No saved profile found');
  }
  if (existsSync(TOKEN_FILE)) {
    rmSync(TOKEN_FILE);
    console.log('Cleared saved token');
  }
} else if (args[0] === '--help') {
  console.log(`
Google Flow Token Extractor

Usage:
  node get-flow-token.js                # Launch browser, login if needed, capture token
  HEADLESS=true node get-flow-token.js  # Run headless (requires prior login)
  node get-flow-token.js --connect <ws> # Connect to existing Chrome
  node get-flow-token.js --clear        # Clear saved profile and token
  node get-flow-token.js --help         # Show this help

Options:
  --connect <ws-url>   Connect to Chrome with remote debugging enabled
  --clear              Clear saved browser profile and token
  --help               Show this help message

Environment Variables:
  HEADLESS=true        Run in headless mode (requires prior login)

Files:
  ~/.flowkey-auto/chrome-profile/   Persistent browser profile (keeps you logged in)
  ~/.flowkey-auto/token.txt         Most recently captured token

To start Chrome with remote debugging:
  # macOS
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222

  # Linux
  google-chrome --remote-debugging-port=9222

  # Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222
`);
} else {
  getFlowToken().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
