# merc-scheduling-bot

A Discord bot for posting runs and letting people sign up for roles.

Using the bot means you agree to the [Terms of Service](TERMS_OF_SERVICE.md) and
[Privacy Policy](PRIVACY_POLICY.md).

## Commands

### `/createrun amount text time clearee role [timezone]`

Posts:

```
5m M4S clear Sunday, September 28, 2026 4:00 PM for @Clearee M1

MT - 
OT - 
H1 - 
H2 - 
M1 - @Clearee
M2 - 
R1 - 
R2 - 
```

- **time** is typed in plain English in *your* timezone, e.g. `sept 28 @ 4 PM`, `tomorrow 8pm`, `friday at 7pm`.
  It becomes a Discord timestamp, so everyone sees it in *their own* local time.
- **role** is one of MT/OT/H1/H2/M1/M2/R1/R2. The clearee gets tagged in that slot automatically.
- **timezone** only has to be given once (autocomplete: `America/New_York`, `EST`, `UTC+8`, ...). After that it's remembered.

Under the post:
- **✅ Sign up**: opens a private menu. Pick MT/OT/H1/H2/M1/M2/R1/R2 and press **Confirm**. Your @ gets added after that role's `-`.
- **❌ Leave**: takes you off the roster.

Only roles that are still open show up in the menu. Each person can hold one slot.

### `/settimezone timezone`

Saves your timezone for `/createrun`.

## Setup

### 1. Install Node.js

You need Node.js 18.17 or newer. Download the **LTS** version from
[nodejs.org](https://nodejs.org) and install it with the default options.
To check it worked, open a new terminal and run `node --version`.

### 2. Create the bot in Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Open the **Bot** tab, click **Reset Token**, and copy the token. Keep it private,
   because anyone who has it can control your bot.

The bot doesn't need any Privileged Gateway Intents.

### 3. Invite it to your server

1. Open **OAuth2 → URL Generator**.
2. Scopes: tick **`bot`** and **`applications.commands`**.
3. Bot permissions: tick **View Channels**, **Send Messages**, and **Read Message History**.
4. Open the generated URL and pick your server.

### 4. Add your token

1. Copy `.env.example` to a new file named `.env` in the same folder.
   (`start_bot.bat` does this for you the first time you run it.)
2. Open `.env` in Notepad and paste your token after `DISCORD_TOKEN=`, with no spaces or quotes:

   ```
   DISCORD_TOKEN=your-token-here
   GUILD_ID=123456789012345678
   ```

3. Optional but recommended: set `GUILD_ID` so the commands show up right away (see
   [Using the bot in multiple servers](#using-the-bot-in-multiple-servers)). To get a server's
   ID, turn on **Developer Mode** in Discord (**User Settings → Advanced**), then right-click
   the server icon and choose **Copy Server ID**.

`.env` is listed in `.gitignore`, so your token is never committed.

## Running the bot

### Windows: double-click `start_bot.bat`

`start_bot.bat` handles everything:

- It checks that Node.js is installed.
- On the first run it creates `.env` and opens it in Notepad so you can paste your token.
  Save the file, then double-click `start_bot.bat` again.
- It runs `npm install` automatically the first time (or if `node_modules` is missing).
- It starts the bot.

When you see `Logged in as YourBot#1234`, the bot is online. Leave the window open,
because closing it (or pressing **Ctrl+C**) stops the bot. If the bot crashes, the window
stays open so you can read the error.

### Any OS: from a terminal

Run these in the `merc-scheduling-bot` folder:

```
npm install
npm start
```

You only need to run `npm install` the first time, and again after updating `package.json`.

### Using the bot in multiple servers

The bot can be in as many servers as you like. Invite it to each one with the same URL from
[step 3](#3-invite-it-to-your-server). Run posts, sign-ups and saved timezones all work
independently in every server. A user's saved timezone follows them across servers.

`GUILD_ID` in `.env` controls where the slash commands are registered:

| `GUILD_ID=` | Where commands appear | Speed |
|---|---|---|
| *(empty)* | Every server the bot is in | Can take up to an hour after changes |
| `all` | Every server the bot is in, including ones it joins later | Instant. **Best for testing.** |
| `111111111111111111,222222222222222222` | Only the listed servers (comma separated) | Instant |

With `all`, or with a listed ID, adding the bot to a server registers the commands there right
away, without a restart. When you switch between modes, the bot removes the old copies, so
commands never show up twice. Restart the bot after changing `GUILD_ID`.

### Updating the bot

After changing the code, stop the bot and start it again. Slash command changes are sent
to Discord on every start.

### Troubleshooting

| Problem | Fix |
|---|---|
| `Missing DISCORD_TOKEN` | `.env` is missing or the token line is empty. See [step 4](#4-add-your-token). |
| `An invalid token was provided` | The token is wrong or was reset. Copy a new one from the **Bot** tab. |
| `'node' is not recognized` | Node.js isn't installed, or you need to open a new terminal after installing it. |
| Commands don't appear | Set `GUILD_ID=all` in `.env` and restart the bot. Also check the invite URL included `applications.commands`. |
| `the bot isn't in that server yet` | A listed `GUILD_ID` doesn't match a server the bot is in. Invite the bot there, or fix the ID. |
| Commands show up twice | Restart the bot once. It clears the leftover copies on startup. |
| "Something went wrong" on Sign up | Give the bot **View Channels** and **Read Message History** in that channel. |

## Files

| File | What it is |
|---|---|
| `start_bot.bat` | Double-click to run the bot on Windows. |
| `.env` | Your token and server ID. You create this from `.env.example`. |
| `src/index.js` | Entry point: slash commands, buttons, and the sign-up menu. |
| `src/roster.js` | Builds the run post and reads or fills role slots. |
| `src/time.js` | Turns text like `sept 28 @ 4 PM` into a Discord timestamp. |
| `src/timezones.js` | Timezone lookup and autocomplete, plus each user's saved timezone. |
| `data/timezones.json` | Created automatically. Stores each user's saved timezone. |
| `LICENSE` | MIT License. |
| `TERMS_OF_SERVICE.md` | Terms of Service. |
| `PRIVACY_POLICY.md` | Privacy Policy. |

`.env` and `data/` are listed in `.gitignore`, so your token and users' saved timezones
are never pushed to GitHub.

## Legal

- [Terms of Service](TERMS_OF_SERVICE.md)
- [Privacy Policy](PRIVACY_POLICY.md)

Discord asks for links to these in the Developer Portal (**General Information → Terms of
Service URL / Privacy Policy URL**) if you make the bot public or verify it. After pushing
to GitHub, you can use the links to these files in your repository.

## Contact

stephk @ discord

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 StephK.
