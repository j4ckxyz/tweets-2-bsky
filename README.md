# Tweets to Bluesky Crossposter

A powerful, set-and-forget tool to mirror your Twitter/X account to Bluesky.

## Why this tool?

Most crossposters are either paid services or lack key features. This tool is designed for power users who want a perfect mirror:

*   **Smart Media Handling:**
    *   **Videos:** Downloads videos from Twitter and uploads them natively to Bluesky (up to 100MB).
    *   **Images:** Uploads high-resolution images with the **correct aspect ratio** (no weird cropping).
    *   **Links:** Automatically removes `t.co` tracking links and expands them to their real destinations.
*   **Smart Features:**
    *   **Language Detection:** Automatically detects the language of your tweet (e.g., English, Japanese) and tags the Bluesky post correctly.
    *   **Human-like Pacing:** Adds a small delay between posts to prevent spam detection and rate limits.
*   **Threads & Replies:**
    *   **Perfect Threading:** If you write a thread (reply to yourself) on Twitter, it appears as a threaded conversation on Bluesky.
    *   **Clean Feed:** Automatically filters out your replies to *other* people, keeping your Bluesky timeline focused on your original content.
    *   **Quotes:** Smartly handles Quote Tweets, embedding the quoted post if available.
*   **History Import:**
    *   Backfill your entire tweet history chronologically (Oldest → Newest).
    *   Preserves original timestamps on posts.
    *   Uses human-like pacing to avoid rate limits.
*   **Safety:**
    *   Designed to use **Alt Account Cookies**. You can use a burner account to fetch tweets, protecting your main account from suspension risks.

## Setup

### 1. Installation

```bash
git clone https://github.com/yourusername/tweets-2-bsky.git
cd tweets-2-bsky
npm install
```

### 2. Configuration (`.env`)

Create a `.env` file in the project folder:

```bash
# --- Twitter Configuration ---
# 1. Log in to x.com (RECOMMENDED: Use a separate "burner" account!)
# 2. Open Developer Tools (F12) -> Application -> Cookies
# 3. Copy the values for 'auth_token' and 'ct0'
TWITTER_AUTH_TOKEN=d03...
TWITTER_CT0=e1a...

# The username of the account you want to MIRROR (e.g., your main account)
# If left empty, it tries to mirror the account you logged in with (NOT RECOMMENDED).
TWITTER_TARGET_USERNAME=jack

# --- Bluesky Configuration ---
BLUESKY_IDENTIFIER=jack.bsky.social
# Generate an App Password in Bluesky Settings -> Privacy & Security
BLUESKY_PASSWORD=xxxx-xxxx-xxxx-xxxx

# --- Optional ---
CHECK_INTERVAL_MINUTES=5
# BLUESKY_SERVICE_URL=https://bsky.social (Change for custom PDS)
```

**⚠️ Safety Tip:**
Twitter is strict about scraping. **Do not use your main account's cookies.**
1.  Create a fresh Twitter account (or use an old alt).
2.  Log in with that alt account in your browser.
3.  Grab the cookies (`auth_token`, `ct0`) from that alt account.
4.  Set `TWITTER_TARGET_USERNAME` to your **main** account's handle (e.g., `elonmusk`).
The tool will use the alt account to "view" your main account's profile and copy the tweets.

### 3. Usage

**Start the Crossposter (Run 24/7):**
Checks for new tweets every 5 minutes.
```bash
node index.js
```

**Import History:**
Migrate your old tweets. This runs once and stops.
```bash
node index.js --import-history
```

## Running on a Server (VPS)

To keep this running 24/7 on a Linux server (e.g., Ubuntu):

1.  **Install PM2 (Process Manager):**
    ```bash
    sudo npm install -g pm2
    ```
2.  **Start the tool:**
    ```bash
    pm2 start index.js --name "twitter-mirror"
    ```
3.  **Check logs:**
    ```bash
    pm2 logs twitter-mirror
    ```
4.  **Enable startup on reboot:**
    ```bash
    pm2 startup
    pm2 save
    ```
