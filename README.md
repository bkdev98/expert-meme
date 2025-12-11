# Google Flow Token Extractor

Automatically extracts the Bearer authorization token from Google Labs Flow (labs.google/fx/tools/flow).

## Installation

```bash
npm install
```

**Note:** Requires Chrome/Chromium installed on your system (uses `channel: 'chrome'`).

## Usage

### First run (login required)

```bash
npm start
```

1. Opens Chrome with a **persistent profile** at `~/.flowkey-auto/chrome-profile/`
2. Navigate to Google Flow
3. You log in once - credentials are saved in the profile
4. Token is captured automatically when API calls are made
5. Saved to `~/.flowkey-auto/token.txt`

### Subsequent runs (headless)

```bash
npm run start:headless
```

Uses the saved Chrome profile so you stay logged in.

### Clear saved data

```bash
npm run clear
```

Deletes the saved profile and token.

### Connect to existing Chrome

Start Chrome with remote debugging:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Then connect:

```bash
node get-flow-token.js --connect ws://127.0.0.1:9222/devtools/browser/<id>
```

## Key Changes (v2)

- **Persistent user data directory** instead of just cookies - Google auth requires full profile persistence
- **Uses system Chrome** (`channel: 'chrome'`) instead of bundled Chromium for better Google compatibility
- **Better automation detection bypass** with `--disable-blink-features=AutomationControlled`

## Output Files

| File | Purpose |
|------|---------|
| `~/.flowkey-auto/chrome-profile/` | Full Chrome profile (cookies, localStorage, etc.) |
| `~/.flowkey-auto/token.txt` | Most recently captured bearer token |

## Using the Token

```bash
# Read directly
cat ~/.flowkey-auto/token.txt

# Export as env var
export FLOW_TOKEN=$(cat ~/.flowkey-auto/token.txt)

# Use with curl
curl -H "Authorization: Bearer $(cat ~/.flowkey-auto/token.txt)" \
  https://aisandbox-pa.googleapis.com/v1/credits
```

## Troubleshooting

**Login required every time?**
- Make sure you're not running `npm run clear` between runs
- Check that `~/.flowkey-auto/chrome-profile/` exists after first login

**Headless mode fails?**
- Run `npm start` (headed) first to complete login
- Google may block headless browsers - the persistent profile helps but isn't foolproof

**Token not captured?**
- Interact with the Flow page to trigger API calls
- The page needs to make a request to `aisandbox-pa.googleapis.com`

**Chrome not found?**
- Install Chrome or change `channel: 'chrome'` to `channel: 'chromium'` in the script
