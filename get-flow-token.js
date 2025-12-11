import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Add stealth plugin to avoid detection
chromium.use(StealthPlugin());

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const API_PATTERN = /aisandbox-pa\.googleapis\.com/;
const CREDITS_PATTERN = /aisandbox-pa\.googleapis\.com\/v1\/credits/;
const AUTH_DIR = join(homedir(), '.flowkey-auto');
const PROFILES_DIR = join(AUTH_DIR, 'profiles');
const TOKENS_FILE = join(AUTH_DIR, 'tokens.json');
const ACCOUNTS_FILE = join(AUTH_DIR, 'accounts.json');

// Ensure directories exist
if (!existsSync(AUTH_DIR)) {
  mkdirSync(AUTH_DIR, { recursive: true });
}
if (!existsSync(PROFILES_DIR)) {
  mkdirSync(PROFILES_DIR, { recursive: true });
}

function sanitizeEmail(email) {
  return email.toLowerCase().trim();
}

function getProfileDir(email) {
  const sanitized = sanitizeEmail(email).replace(/@/g, '_at_').replace(/\./g, '_');
  return join(PROFILES_DIR, sanitized);
}

function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveTokens(tokens) {
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function saveToken(email, token) {
  const tokens = loadTokens();
  tokens[sanitizeEmail(email)] = {
    token,
    updatedAt: new Date().toISOString(),
  };
  saveTokens(tokens);
}

function getToken(email) {
  const tokens = loadTokens();
  return tokens[sanitizeEmail(email)];
}

function removeProfile(email) {
  const profileDir = getProfileDir(email);
  if (existsSync(profileDir)) {
    rmSync(profileDir, { recursive: true, force: true });
  }
  const tokens = loadTokens();
  delete tokens[sanitizeEmail(email)];
  saveTokens(tokens);
}

function listProfiles() {
  const tokens = loadTokens();
  return Object.entries(tokens).map(([email, data]) => ({
    email,
    token: data.token,
    updatedAt: data.updatedAt,
  }));
}

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return {};
  try {
    const accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    // Convert array to object keyed by email
    const map = {};
    for (const acc of accounts) {
      map[sanitizeEmail(acc.email)] = acc.password;
    }
    return map;
  } catch (e) {
    return {};
  }
}

function saveAccountsArray(accounts) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

async function getFlowToken(email, options = {}) {
  const { headless = false, forceLogin = false, password = null } = options;
  const profileDir = getProfileDir(email);
  const hasProfile = existsSync(profileDir);

  console.log(`\n[${email}] Starting...`);
  console.log(`[${email}] Profile: ${hasProfile ? 'exists' : 'new'}`);

  if (forceLogin && hasProfile) {
    console.log(`[${email}] Force login - removing old profile`);
    removeProfile(email);
  }

  const context = await chromium.launchPersistentContext(getProfileDir(email), {
    headless,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  let page = context.pages()[0] || await context.newPage();

  let capturedToken = null;
  let capturedCredits = null;
  let tokenResolve;
  const tokenPromise = new Promise((resolve) => {
    tokenResolve = resolve;
  });

  // Intercept requests to capture token
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (API_PATTERN.test(url)) {
      const headers = request.headers();
      const authHeader = headers['authorization'];

      if (authHeader && authHeader.startsWith('Bearer ') && !capturedToken) {
        capturedToken = authHeader.replace('Bearer ', '');
        console.log(`[${email}] Token captured!`);
        console.log(`[${email}] Token: ${capturedToken}`);
        tokenResolve(capturedToken);
      }
    }

    await route.continue();
  });

  // Listen for credits response
  page.on('response', async (response) => {
    const url = response.url();
    if (CREDITS_PATTERN.test(url) && response.status() === 200) {
      try {
        const data = await response.json();
        if (data.credits !== undefined) {
          capturedCredits = data;
          console.log(`[${email}] Credits: ${data.credits} (${data.userPaygateTier || 'unknown tier'})`);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
  });

  // Navigate to Flow
  console.log(`[${email}] Opening Flow...`);
  try {
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log(`[${email}] Navigation timeout, continuing...`);
  }

  await page.waitForTimeout(500);

  // Try to click "Create with Flow" or similar button to trigger login
  console.log(`[${email}] Looking for login trigger button...`);

  const buttonSelectors = [
    'button:has-text("Create with Flow")',
    'button:has-text("Create")',
    'button:has-text("Sign in")',
    'button:has-text("Get started")',
    'button:has-text("Start")',
    'a:has-text("Sign in")',
    '[data-action="sign-in"]',
  ];

  let clickedButton = false;
  for (const selector of buttonSelectors) {
    try {
      const button = await page.$(selector);
      if (button && await button.isVisible()) {
        console.log(`[${email}] Clicking: ${selector}`);
        await button.click();
        clickedButton = true;
        break;
      }
    } catch (e) {
      // Continue to next selector
    }
  }

  if (!clickedButton) {
    // Try clicking any prominent button
    try {
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await btn.textContent().catch(() => '');
        const isVisible = await btn.isVisible().catch(() => false);
        if (isVisible && text && (text.includes('Create') || text.includes('Sign') || text.includes('Start'))) {
          console.log(`[${email}] Clicking: "${text.trim()}"`);
          await btn.click();
          clickedButton = true;
          break;
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  // Wait for redirect to login
  await page.waitForTimeout(1500);

  let currentUrl = page.url();
  console.log(`[${email}] Current URL: ${currentUrl}`);

  // Check if redirected to Google login
  const needsLogin = currentUrl.includes('accounts.google.com') ||
                     currentUrl.includes('/signin') ||
                     currentUrl.includes('authui');

  if (needsLogin) {
    if (headless) {
      console.log(`[${email}] Login required - cannot proceed in headless mode`);
      console.log(`[${email}] Run without --headless to login manually`);
      await context.close();
      return { email, success: false, error: 'login_required' };
    }

    // Pre-fill email with human-like typing
    try {
      await page.waitForSelector('input[type="email"]', { timeout: 3000 });
      console.log(`[${email}] Entering email...`);

      // Click and type like a human
      await page.click('input[type="email"]');
      await page.waitForTimeout(200 + Math.random() * 300);
      await page.type('input[type="email"]', email, { delay: 50 + Math.random() * 50 });
      await page.waitForTimeout(300 + Math.random() * 400);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500 + Math.random() * 1000);

      // Pre-fill password if provided
      if (password) {
        try {
          await page.waitForSelector('input[type="password"]', { timeout: 5000 });
          console.log(`[${email}] Entering password...`);

          await page.click('input[type="password"]');
          await page.waitForTimeout(200 + Math.random() * 300);
          await page.type('input[type="password"]', password, { delay: 50 + Math.random() * 50 });
          await page.waitForTimeout(300 + Math.random() * 400);
          await page.keyboard.press('Enter');
          console.log(`[${email}] Credentials submitted, waiting for login...`);
        } catch (e) {
          console.log(`[${email}] Password field not found, please enter manually`);
        }
      } else {
        console.log(`[${email}] Email entered - please enter password manually...`);
      }
    } catch (e) {
      console.log(`[${email}] Could not pre-fill email, please login manually`);
    }

    console.log(`[${email}] Waiting for login...`);

    try {
      await page.waitForURL((url) => {
        const urlStr = url.toString();
        return urlStr.includes('labs.google/fx') &&
               !urlStr.includes('signin') &&
               !urlStr.includes('accounts.google.com');
      }, { timeout: 300000 });

      console.log(`[${email}] Login successful!`);
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log(`[${email}] Login timeout or cancelled`);
      await context.close();
      return { email, success: false, error: 'login_timeout' };
    }
  } else {
    // Check if we're logged in by looking for user avatar or account menu
    const loggedInIndicators = [
      'img[alt*="avatar"]',
      'img[alt*="profile"]',
      '[aria-label*="Account"]',
      '[aria-label*="Google Account"]',
    ];

    let isLoggedIn = false;
    for (const selector of loggedInIndicators) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          isLoggedIn = true;
          break;
        }
      } catch (e) {}
    }

    if (isLoggedIn) {
      console.log(`[${email}] Already logged in!`);
    } else {
      // Not redirected to login, but might not be logged in
      // Wait and see if token gets captured
      console.log(`[${email}] Checking login status...`);
    }
  }

  // Wait for token
  if (!capturedToken) {
    console.log(`[${email}] Waiting for API request to capture token...`);

    // Try to trigger API call
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.evaluate(() => window.scrollBy(0, 100));
      await page.waitForTimeout(2000);
    } catch (e) {}

    // Wait with timeout
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 30000));
    await Promise.race([tokenPromise, timeout]);
  }

  // If still no token, wait longer for manual interaction
  if (!capturedToken && !headless) {
    console.log(`[${email}] No token yet - interact with the page to trigger API calls`);
    console.log(`[${email}] Waiting up to 2 more minutes...`);

    const extendedTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 120000));
    await Promise.race([tokenPromise, extendedTimeout]);
  }

  await context.close();

  if (capturedToken) {
    saveToken(email, capturedToken);
    console.log(`[${email}] Token saved!`);
    return {
      email,
      success: true,
      token: capturedToken,
      credits: capturedCredits?.credits ?? null,
      tier: capturedCredits?.userPaygateTier ?? null,
    };
  } else {
    console.log(`[${email}] Failed to capture token`);
    return { email, success: false, error: 'no_token' };
  }
}

async function processEmails(emails, options = {}) {
  const results = [];
  const accounts = loadAccounts();

  for (const email of emails) {
    const password = accounts[sanitizeEmail(email)] || null;
    const result = await getFlowToken(email, { ...options, password });
    results.push(result);
  }

  return results;
}

async function submitToApi(endpoint, results) {
  const successful = results.filter(r => r.success);

  if (successful.length === 0) {
    console.log('\nNo tokens to submit');
    return;
  }

  console.log(`\nSubmitting ${successful.length} tokens to ${endpoint}...`);

  const payload = successful.map(r => ({
    email: r.email,
    token: r.token,
    credits: r.credits,
    tier: r.tier,
  }));

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log('API submission successful!');
      const data = await response.json().catch(() => ({}));
      return { success: true, data };
    } else {
      console.log(`API error: ${response.status} ${response.statusText}`);
      return { success: false, status: response.status };
    }
  } catch (e) {
    console.log(`API request failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

function printResults(results) {
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));

  for (const r of results) {
    if (r.success) {
      const creditsInfo = r.credits !== null ? ` | Credits: ${r.credits}` : '';
      const tierInfo = r.tier ? ` (${r.tier})` : '';
      console.log(`✓ ${r.email}${creditsInfo}${tierInfo}`);
    } else {
      console.log(`✗ ${r.email}: ${r.error}`);
    }
  }

  const successful = results.filter(r => r.success).length;
  const totalCredits = results.filter(r => r.success && r.credits !== null).reduce((sum, r) => sum + r.credits, 0);

  console.log(`\n${successful}/${results.length} succeeded`);
  if (totalCredits > 0) {
    console.log(`Total credits: ${totalCredits}`);
  }
}

function printTokensJson(results) {
  const successful = results.filter(r => r.success);
  const output = successful.map(r => ({
    email: r.email,
    token: r.token,
    credits: r.credits,
    tier: r.tier,
  }));
  console.log(JSON.stringify(output, null, 2));
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Google Flow Token Extractor

Usage:
  node get-flow-token.js <email1> [email2] ...    Get tokens for emails
  node get-flow-token.js --all                    Get tokens for ALL accounts in accounts.json
  node get-flow-token.js --list                   List all saved tokens
  node get-flow-token.js --accounts-init          Create sample accounts.json
  node get-flow-token.js --refresh <email>        Force re-login for email
  node get-flow-token.js --remove <email>         Remove saved profile
  node get-flow-token.js --clear                  Clear all profiles

Options:
  --all                   Run all accounts from accounts.json (sequential)
  --headless              Run in headless mode (only works if already logged in)
  --json                  Output tokens as JSON
  --submit <url>          Submit tokens to API endpoint
  --refresh               Force re-login (remove existing profile first)
  --list                  List all saved tokens
  --accounts-init         Create sample accounts.json file
  --remove <email>        Remove a specific profile
  --clear                 Remove all profiles and tokens

Accounts File (auto-fills email + password):
  Create ~/.flowkey-auto/accounts.json with:
  [
    { "email": "user1@gmail.com", "password": "pass1" },
    { "email": "user2@gmail.com", "password": "pass2" }
  ]

Examples:
  # Setup accounts file first
  node get-flow-token.js --accounts-init
  # Then edit ~/.flowkey-auto/accounts.json with your credentials

  # Run ALL accounts from accounts.json (sequential)
  node get-flow-token.js --all

  # Login and get token (auto-fills email+password if in accounts.json)
  node get-flow-token.js user@gmail.com

  # Get tokens for multiple accounts
  node get-flow-token.js user1@gmail.com user2@gmail.com user3@gmail.com

  # Refresh expired token
  node get-flow-token.js --refresh user@gmail.com

  # Get tokens headless (if already logged in)
  node get-flow-token.js --headless user@gmail.com

  # Run all accounts and submit to API
  node get-flow-token.js --all --submit https://api.example.com/tokens

  # Output as JSON
  node get-flow-token.js --all --json

Files:
  ~/.flowkey-auto/accounts.json   Email + password pairs (optional)
  ~/.flowkey-auto/profiles/       Browser profiles per email
  ~/.flowkey-auto/tokens.json     All captured tokens
`);
  process.exit(0);
}

if (args.includes('--accounts-init')) {
  const sample = [
    { email: 'user1@gmail.com', password: 'password1' },
    { email: 'user2@gmail.com', password: 'password2' },
  ];
  saveAccountsArray(sample);
  console.log(`Created sample accounts file: ${ACCOUNTS_FILE}`);
  console.log('Edit this file with your actual credentials.');
  process.exit(0);
}

if (args.includes('--all')) {
  // Run all accounts from accounts.json
  if (!existsSync(ACCOUNTS_FILE)) {
    console.log('No accounts.json found. Create one first:');
    console.log('  node get-flow-token.js --accounts-init');
    process.exit(1);
  }

  let accounts = [];
  try {
    accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
  } catch (e) {
    console.log('Error reading accounts.json:', e.message);
    process.exit(1);
  }

  if (accounts.length === 0) {
    console.log('No accounts in accounts.json');
    process.exit(1);
  }

  const emails = accounts.map(a => a.email);
  console.log(`Processing all ${emails.length} accounts from accounts.json...`);

  const headless = args.includes('--headless');
  const forceLogin = args.includes('--refresh');
  const jsonOutput = args.includes('--json');

  let submitEndpoint = null;
  if (args.includes('--submit')) {
    const idx = args.indexOf('--submit');
    submitEndpoint = args[idx + 1];
  }

  const results = await processEmails(emails, { headless, forceLogin });

  if (jsonOutput) {
    printTokensJson(results);
  } else {
    printResults(results);
  }

  if (submitEndpoint) {
    await submitToApi(submitEndpoint, results);
  }

  process.exit(0);
}

if (args.includes('--list')) {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('No saved profiles');
  } else {
    console.log('Saved profiles:\n');
    for (const p of profiles) {
      console.log(`  ${p.email}`);
      console.log(`    Token: ${p.token.substring(0, 40)}...`);
      console.log(`    Updated: ${p.updatedAt}`);
      console.log('');
    }
  }
  process.exit(0);
}

if (args.includes('--clear')) {
  if (existsSync(PROFILES_DIR)) {
    rmSync(PROFILES_DIR, { recursive: true, force: true });
    mkdirSync(PROFILES_DIR, { recursive: true });
  }
  if (existsSync(TOKENS_FILE)) {
    rmSync(TOKENS_FILE);
  }
  console.log('Cleared all profiles and tokens');
  process.exit(0);
}

if (args.includes('--remove')) {
  const idx = args.indexOf('--remove');
  const email = args[idx + 1];
  if (!email || email.startsWith('--')) {
    console.log('Usage: node get-flow-token.js --remove <email>');
    process.exit(1);
  }
  removeProfile(email);
  console.log(`Removed profile for ${email}`);
  process.exit(0);
}

// Parse options
const headless = args.includes('--headless');
const jsonOutput = args.includes('--json');
const forceLogin = args.includes('--refresh');

let submitEndpoint = null;
if (args.includes('--submit')) {
  const idx = args.indexOf('--submit');
  submitEndpoint = args[idx + 1];
  if (!submitEndpoint || submitEndpoint.startsWith('--')) {
    console.log('Usage: node get-flow-token.js <emails> --submit <url>');
    process.exit(1);
  }
}

// Get emails (filter out flags and their values)
const flagsWithValues = ['--submit', '--remove'];
const emails = args.filter((arg, idx) => {
  if (arg.startsWith('--')) return false;
  const prevArg = args[idx - 1];
  if (prevArg && flagsWithValues.includes(prevArg)) return false;
  return true;
});

if (emails.length === 0) {
  console.log('No emails provided. Use --help for usage.');
  process.exit(1);
}

// Process emails
console.log(`Processing ${emails.length} email(s)...`);
const results = await processEmails(emails, { headless, forceLogin });

if (jsonOutput) {
  printTokensJson(results);
} else {
  printResults(results);
}

// Submit to API if requested
if (submitEndpoint) {
  await submitToApi(submitEndpoint, results);
}
