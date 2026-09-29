# Merc Scheduling Bot

A Discord bot for posting merc runs and letting people sign up for a role.

## Add the bot to your server!

[Click here to add Merc Scheduling Bot to your server](https://discord.com/oauth2/authorize?client_id=1554373434744504330&permissions=76816&integration_type=0&scope=bot+applications.commands)

Pick your server and click Authorize. You need the Manage Server permission to add bots.
The commands may take a minute to show up after the bot joins.

By using the bot you agree to the [Terms of Service](TERMS_OF_SERVICE.md) and
[Privacy Policy](PRIVACY_POLICY.md).

## Creating a run

```
/createrun amount text time clearee role
```

For example, `/createrun amount:5m text:M4S clear time:sept 28 @ 4 PM clearee:@Steph role:M1` posts:

```
5m M4S clear Sunday, September 28, 2026 4:00 PM for @Steph M1

MT -
OT -
H1 -
H2 -
M1 - @Steph
M2 -
R1 -
R2 -
```

- **time** can be written however you'd normally say it: `sept 28 @ 4 PM`, `tomorrow 8pm`, `friday at 7pm`.
  Everyone sees it in their own timezone.
- **role** is the clearee's role. They're added to that slot automatically.
- The first time you use `/createrun`, fill in the optional **timezone** option (for example
  `America/New_York` or `EST`) so the bot knows what "4 PM" means for you. It remembers it after that.
  You can change it any time with `/settimezone`.

## Signing up

Click **✅ Sign up** under a run, choose from the menu and press **Confirm**. Click **❌ Leave** to drop out.
Clicking Sign up again lets you change your pick.

You can choose:

- **One role**: you get that role.
- **Several roles (flex)**: you're put in whichever one is free, shown like `H2 - @you (flex: H2/R1/R2)`.
  If someone else later picks your slot as their only role, you get moved to one of your other roles.
- **BENCH**: you're a backup and won't be put in a slot. You can also tick the roles you're able to cover.

The menu shows which roles are open or taken, and tells you where you'll end up before you confirm.

### Who gets priority

First come, first served. Nobody can take a slot away from someone who signed up before them.
A flex player can be moved to another of their roles to make room, but only if one is free.
If not, they keep their slot and the newer person goes on the waitlist.

When a slot opens up, the first person on the waitlist who wanted it is moved in automatically.

Changing your pick puts you at the back of the line.

### Example

1. User 1 picks H2, R1 and R2. They get H2.
2. User 2 picks only H2. User 1 moves to R1.
3. User 3 picks only R1. User 1 moves to R2.
4. User 4 picks only R2. User 1 has nowhere else to go and signed up first, so User 4 is waitlisted.

```
H2 - @User2
R1 - @User3
R2 - @User1

Waitlist - @User4 (R2)
Bench - @User5 (MT/OT)
```

If User 3 leaves, User 1 moves back to R1 and User 4 gets R2.

## Commands

| Command | What it does |
|---|---|
| `/createrun` | Post a new run for people to sign up to |
| `/settimezone` | Save or change your timezone |

---

## Running your own copy

You don't need any of this if you're using the invite link above. It's only for hosting the bot yourself.

### What you need

- [Node.js](https://nodejs.org) 18.17 or newer (the LTS version is fine)
- A Discord bot token

### 1. Make a bot on Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. On the **Bot** tab, click **Reset Token** and copy it. Don't share it with anyone.
3. Under **OAuth2 → URL Generator**, tick `bot` and `applications.commands`, then tick
   View Channels, Send Messages and Read Message History. Open the link it gives you to add the bot to your server.

### 2. Add your token

Copy `.env.example` to a new file called `.env` and paste your token in:

```
DISCORD_TOKEN=your-token-here
GUILD_ID=all
```

`GUILD_ID=all` makes the commands show up straight away in every server the bot is in.
You can also list specific server IDs separated by commas, or leave it blank to register
the commands globally (slower, can take up to an hour).

### 3. Start it

On Windows, double-click `start_bot.bat`. The first time, it creates `.env` for you and
opens it in Notepad. Paste your token, save, and run it again. It installs everything it
needs and starts the bot.

On any other system, run this in the project folder:

```
npm install
npm start
```

Once you see `Logged in as ...` the bot is online. Keep the window open, since closing it stops the bot.
After changing any code, stop the bot and start it again.

To run the tests: `npm test`

### Something not working?

| Problem | Fix |
|---|---|
| `Missing DISCORD_TOKEN` | `.env` is missing or the token is blank. |
| `An invalid token was provided` | The token is wrong or was reset. Get a new one from the Bot tab. |
| `'node' is not recognized` | Install Node.js, then open a new terminal. |
| Commands don't show up | Set `GUILD_ID=all` and restart. Make sure the invite included `applications.commands`. |
| Commands show up twice | Restart the bot once and it cleans them up. |
| "Something went wrong" when signing up | The bot needs View Channels and Read Message History in that channel. |

Your token (`.env`) and the bot's saved data (`data/`) are in `.gitignore`, so they never get pushed to GitHub.

## Contact

stephk @ discord

## License

[MIT](LICENSE) © 2026 StephK
