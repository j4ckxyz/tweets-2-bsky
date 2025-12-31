# 🐦 Tweets-2-Bsky

A powerful tool to crosspost your Tweets to Bluesky automatically. Now supports **multiple accounts**, **custom PDS (hosting) locations**, and a **user-friendly CLI** for easy management.

## ✨ Features

- **Multi-Account Support**: Sync Twitter A -> Bluesky A, Twitter B -> Bluesky B, or multiple Twitters to one Bluesky.
- **Interactive CLI**: Manage all your account mappings and credentials without touching code.
- **Custom PDS Support**: Works with `bsky.social` or any independent Bluesky hosting provider.
- **Thread Support**: Maintains your Twitter threads perfectly on Bluesky.
- **Media Support**: Automatically migrates high-quality images and videos.
- **Smart Logic**: Automatically detects languages and expands short links.
- **Safety First**: Includes a `--dry-run` mode to test before you post.

---

## 🚀 Quick Start (For Everyone)

### 1. Prerequisites
- **Node.js** installed on your computer.
- A Twitter account (preferably an alt/burner for the web cookies).
- A Bluesky account and an **App Password** (Settings -> Privacy & Security -> App Passwords).

### 2. Installation
Open your terminal and run:
```bash
git clone https://github.com/j4ckxyz/tweets-2-bsky.git
cd tweets-2-bsky
npm install
```

### 3. Setup (Using the CLI)
Instead of editing files, use our simple setup command:
```bash
# 1. Set your Twitter cookies (one set of cookies works for all mappings)
npm run cli setup-twitter

# 2. Add your first account mapping
npm run cli add-mapping
```
*Note: You can find your Twitter `auth_token` and `ct0` in your browser's developer tools under Application -> Cookies.*

### 4. Run the Sync
```bash
# Build the project
npm run build

# Start the automatic syncing daemon
npm start
```

---

## 🛠 Advanced Usage

### Backfilling Old Tweets
If you want to import your historical tweets for a specific account:
```bash
# Get the command from the CLI help
npm run cli import-history

# Example: Import the last 10 tweets for a specific user
npm run import -- --username YOUR_TWITTER_HANDLE --limit 10
```

### Testing with Dry Run
See what would be posted without actually posting anything:
```bash
npm start -- --dry-run
```

### Management Commands
```bash
npm run cli list             # Show all active mappings
npm run cli remove           # Remove an account mapping
npm run cli set-interval     # Change how often to check for new tweets
```

---

## 📝 Configuration Details

- **Check Interval**: Default is 5 minutes.
- **Database**: Processed tweets are tracked per-account in the `processed/` folder so you never get duplicates.
- **Service URL**: If you use a custom Bluesky host (like `bsky.network`), you can set it during the `add-mapping` process.

## ⚖️ License
MIT

---
*Created with ❤️ for the decentralized web.*