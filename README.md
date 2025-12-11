# Google Flow Token Extractor

Automatically extract Bearer authorization tokens from Google Labs Flow (labs.google/fx/tools/flow) for multiple accounts.

## Features

- **Multi-account support** - Process multiple Google accounts sequentially
- **Auto-fill credentials** - Automatically fills email and password from config file
- **Token capture** - Intercepts API requests to capture Bearer tokens
- **Credits tracking** - Captures account credits and tier information
- **Persistent sessions** - Saves browser profiles to stay logged in
- **Daemon mode** - Run automatically every day at midnight
- **API submission** - POST tokens to your API endpoint
- **Firestore integration** - Push tokens directly to Firebase Firestore
- **Stealth mode** - Uses playwright-extra with stealth plugin to avoid detection

## Installation

```bash
git clone <repo>
cd flowkey-auto
npm install
```

### Requirements

- Node.js 18+
- Google Chrome installed on your system

## Quick Start

### 1. Initialize accounts file

```bash
node get-flow-token.js --accounts-init
```

This creates `~/.flowkey-auto/accounts.json`. Edit it with your credentials:

```json
[
  { "email": "user1@gmail.com", "password": "password1" },
  { "email": "user2@gmail.com", "password": "password2" },
  { "email": "user3@gmail.com", "password": "password3" }
]
```

### 2. Run for all accounts

```bash
# First run - browser opens, auto-fills credentials
# You may need to complete login manually if Google blocks automation
node get-flow-token.js --all

# After first login, sessions are saved. Use headless mode:
node get-flow-token.js --all --headless
```

### 3. View results

```bash
node get-flow-token.js --list
```

## Usage

### Basic Commands

```bash
# Single account
node get-flow-token.js user@gmail.com

# Multiple accounts
node get-flow-token.js user1@gmail.com user2@gmail.com user3@gmail.com

# All accounts from accounts.json
node get-flow-token.js --all

# List saved tokens and profiles
node get-flow-token.js --list

# Force re-login (clear profile and login again)
node get-flow-token.js --refresh user@gmail.com

# Remove a profile
node get-flow-token.js --remove user@gmail.com

# Clear all profiles and tokens
node get-flow-token.js --clear
```

### Output Formats

```bash
# Standard output (default)
node get-flow-token.js --all

# JSON output
node get-flow-token.js --all --json
```

**Standard output:**
```
============================================================
RESULTS
============================================================
✓ user1@gmail.com | Credits: 880 (PAYGATE_TIER_ONE)
✓ user2@gmail.com | Credits: 500 (PAYGATE_TIER_ONE)
✗ user3@gmail.com: login_timeout

2/3 succeeded
Total credits: 1380
```

**JSON output:**
```json
[
  {
    "email": "user1@gmail.com",
    "token": "ya29.a0AW...",
    "credits": 880,
    "tier": "PAYGATE_TIER_ONE"
  },
  {
    "email": "user2@gmail.com",
    "token": "ya29.a0AX...",
    "credits": 500,
    "tier": "PAYGATE_TIER_ONE"
  }
]
```

### API Submission

Submit tokens to your API endpoint:

```bash
node get-flow-token.js --all --submit https://api.example.com/tokens
```

Sends a POST request with JSON body:
```json
[
  {
    "email": "user1@gmail.com",
    "token": "ya29.xxx...",
    "credits": 880,
    "tier": "PAYGATE_TIER_ONE"
  }
]
```

### Firestore Integration

Push tokens directly to Firebase Firestore.

#### Setup

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project → Project Settings → Service Accounts
3. Click "Generate new private key"
4. Save the file as `~/.flowkey-auto/firebase-service-account.json`

#### Usage

```bash
# Push to default collection (flow_tokens)
node get-flow-token.js --all --firestore-push

# Custom collection name
node get-flow-token.js --all --firestore-push --firestore-collection my_tokens
```

#### Document Structure

Collection: `flow_tokens`

Document ID: `user_at_gmail_com` (sanitized email)

```json
{
  "email": "user@gmail.com",
  "token": "ya29.xxx...",
  "credits": 880,
  "tier": "PAYGATE_TIER_ONE",
  "updatedAt": "2025-12-11T00:00:00.000Z"
}
```

### Daemon Mode

Run automatically every day at midnight. Reloads `accounts.json` on each run, so you can add/remove accounts without restarting.

```bash
# Basic daemon
node get-flow-token.js --daemon

# With API submission
node get-flow-token.js --daemon --submit https://api.example.com/tokens

# With Firestore push
node get-flow-token.js --daemon --firestore-push

# Combined
node get-flow-token.js --daemon --submit https://api.example.com/tokens --firestore-push
```

#### Running in Background

```bash
# Using nohup
nohup node get-flow-token.js --daemon --firestore-push > daemon.log 2>&1 &

# Using pm2
pm2 start get-flow-token.js --name "flowkey-daemon" -- --daemon --firestore-push

# View logs
pm2 logs flowkey-daemon
```

## npm Scripts

```bash
npm run start              # Run with no arguments (shows help)
npm run all                # Run all accounts from accounts.json
npm run daemon             # Run in daemon mode
npm run list               # List saved profiles and tokens
npm run clear              # Clear all profiles and tokens
npm run init               # Create sample accounts.json
```

## File Locations

All data is stored in `~/.flowkey-auto/`:

| File | Description |
|------|-------------|
| `accounts.json` | Email and password pairs |
| `tokens.json` | Captured tokens with timestamps |
| `profiles/` | Browser profiles (one per email) |
| `firebase-service-account.json` | Firebase credentials (for Firestore) |

## Command Reference

```
Usage:
  node get-flow-token.js <email1> [email2] ...    Get tokens for emails
  node get-flow-token.js --all                    Get tokens for ALL accounts in accounts.json
  node get-flow-token.js --daemon                 Run as daemon (daily at midnight)
  node get-flow-token.js --list                   List all saved tokens
  node get-flow-token.js --accounts-init          Create sample accounts.json
  node get-flow-token.js --refresh <email>        Force re-login for email
  node get-flow-token.js --remove <email>         Remove saved profile
  node get-flow-token.js --clear                  Clear all profiles

Options:
  --all                   Run all accounts from accounts.json (sequential)
  --daemon                Run as background daemon, refresh daily at midnight
  --headless              Run in headless mode (only works if already logged in)
  --json                  Output tokens as JSON
  --submit <url>          Submit tokens to API endpoint
  --firestore-push        Push results to Firestore
  --firestore-collection  Firestore collection name (default: flow_tokens)
  --refresh               Force re-login (remove existing profile first)
  --list                  List all saved tokens
  --accounts-init         Create sample accounts.json file
  --remove <email>        Remove a specific profile
  --clear                 Remove all profiles and tokens
```

## How It Works

1. **Opens Chrome** with a persistent profile for each email
2. **Navigates to Flow** (labs.google/fx/tools/flow)
3. **Clicks "Create with Flow"** to trigger login
4. **Auto-fills email and password** (if provided in accounts.json)
5. **Waits for login** - you may need to complete manually if Google blocks
6. **Intercepts API requests** to capture the Bearer token
7. **Captures credits** from the `/v1/credits` endpoint
8. **Saves profile** for future headless runs

## Troubleshooting

### Google blocks automated login

Google may detect automation and block login. Solutions:

1. **Complete login manually** - The browser stays open, just enter your password
2. **Use accounts without 2FA** - 2FA accounts are harder to automate
3. **Don't run too many at once** - Process accounts one at a time
4. **Wait between runs** - Don't run too frequently

### Token not captured

- Interact with the Flow page to trigger API requests
- Make sure you're fully logged in
- Check that the page loads completely

### Headless mode fails

- Run in headed mode first to complete login
- Check that the profile exists: `node get-flow-token.js --list`
- Clear and re-login: `node get-flow-token.js --refresh user@gmail.com`

### Firebase errors

- Verify `firebase-service-account.json` is in `~/.flowkey-auto/`
- Check that the service account has Firestore write permissions
- Ensure your Firebase project has Firestore enabled

## Security Notes

- **Passwords are stored in plain text** in `accounts.json`
- Keep `~/.flowkey-auto/` secure and don't commit it to git
- Consider using environment variables for sensitive data in production
- The Firebase service account key should be kept private

## License

MIT
