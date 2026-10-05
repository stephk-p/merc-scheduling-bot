# Merc Scheduling Bot

A Discord bot for posting merc runs and letting people sign up for a role.

## Add the bot to your server!

[Click here to add Merc Scheduling Bot to your server](https://discord.com/oauth2/authorize?client_id=1554373434744504330&permissions=268643344&integration_type=0&scope=bot+applications.commands)

Pick your server and click Authorize. You need the Manage Server permission to add bots.
The commands may take a minute to show up after the bot joins.

By using the bot you agree to the [Terms of Service](TERMS_OF_SERVICE.md) and
[Privacy Policy](PRIVACY_POLICY.md).

## Creating a run

```
/createrun amount merc_run_type clearee role job time [extra_clearees]
```

For example, `/createrun amount:5m merc_run_type:M4S clear clearee:Steph role:M1 job:NIN/SAM time:sept 28 @ 4 PM` posts:

```
@here
5m M4S clear for Steph (NIN/SAM) - M1 @ Sunday, September 28, 2026 4:00 PM

MT -
OT -
H1 -
H2 -
M1 - Steph (NIN/SAM)
M2 -
R1 -
R2 -
```

The post pings `@here` on the first line (some servers ping a role instead, see [Role restrictions](#role-restrictions)).
The ping only goes out when the run is posted, not when people sign up or the post is updated.

It also creates a private channel called `5m-m4s-clear-stephk-monday-sep-28` (amount, merc run type, clearee,
weekday and date of the run). On servers set up for it (see `RUN_CHANNEL_CATEGORY` in
[src/config.js](src/config.js)) it always goes under that category; otherwise it's created in the same
category the command was used in. Only you, the clearee and the people who sign up can see it.
People are added when they sign up and removed if they leave.

The private channel starts with a pinned copy of the run post (without the ping).
It's updated along with the run post whenever someone signs up, leaves, or the run is
completed, failed or rescheduled. Sign up and leave from the original post.
That roster is the only message the bot posts in the channel. Nobody is @mentioned when they're added.

- **clearee** can be picked from the list of server members as you type, or you can type any name.
  If it matches a server member (their nickname, display name or username), they get the slot and are
  added to the private channel. If they can also see the channel the run is posted in, they're
  @mentioned (and pinged) there too, just like a normal sign-up. If nobody matches, or they can't see
  the channel, they're just shown by name instead.
- **time** can be written however you'd normally say it: `sept 28 @ 4 PM`, `tomorrow 8pm`, `friday at 7pm`.
  Everyone sees it in their own timezone.
- **role** is the clearee's role. They're added to that slot automatically.
- **job** is the clearee's job for that role, picked from the list as you type. Add more than one with
  `/`, like `NIN/SAM`. It's **required** (see the job list under [Signing up](#signing-up)).
- **extra_clearees** (optional) is a number (1-5) of additional clearees to add to the roster. After you
  submit the command, a form pops up with one line per extra clearee — type each as `Name, Role, Job(s)`,
  e.g. `Alex, H1, WHM` (job is only required for MT/OT/M1/M2). No two clearees can share a role. The post
  then reads like `5m M4S clear for Steph (NIN/SAM) - M1 & Alex (WHM) - H1 @ Sunday, September 28, 2026 4:00 PM`.
  Any extra clearee matching a server member who can see the channel the run is posted in is `@mentioned`
  (and pinged) instead of named; either way, a matching member is added to the private channel.
- The first time you use `/createrun`, fill in the optional **timezone** option (for example
  `America/New_York` or `EST`) so the bot knows what "4 PM" means for you. It remembers it after that.
  You can change it any time with `/settimezone`.
- **notes** (optional) adds a line right under the header: `**Note:** your text here` — handy for
  things like "no echo" or "prog from P4". Leave it blank for no note line at all.

`/privaterun` works exactly like `/createrun` (same options), except it can only be used in one
specific channel (see `PRIVATE_RUN_CHANNEL_ID` in [src/config.js](src/config.js); used anywhere
else, it just replies telling you which channel to use), and its post never pings `@here` or a role.

## Signing up

Click **✅ Sign up** under a run, choose from the menu and press **Confirm**. Click **❌ Leave** to drop out.
Clicking Sign up again lets you change your pick. If `signupRoles` (below) limits who can sign up, that only
applies to joining in the first place — once you're on the roster you can always manage your own pick with
**Sign up** or **🛠️ Manage Signup** (handy if you were added by someone else and aren't in `signupRoles`
yourself). Manage Signup does nothing at all if you're not already signed up for that run.

You can choose:

- **One role**: you get that role.
- **Several roles (flex)**: tick them in order of preference. You get the first one on your list that's free,
  shown like `H2 - @you (flex: H2/R1/R2)`. If someone else later picks your slot as their only role, you move
  to your next choice, and you move back up your list when a higher choice opens up.
  The menu shows `(choice #1)`, `(choice #2)` and so on next to each role. To change the order, untick a role
  and tick it again; it goes to the end of your list.
- **BENCH**: you're a backup and won't be put in a slot. You can also tick the roles you're able to cover.

After picking roles, more menus appear so you can pick your jobs. You can pick more than one:

| Role | Jobs | |
|---|---|---|
| MT / OT | GNB, DRK, PLD, WAR | **Required** |
| M1 / M2 | NIN, MNK, DRG, SAM, RPR, VPR | **Required** |
| H1 | WHM, AST | Optional |
| H2 | SCH, SGE | Optional |
| R1 | BRD, MCH, DNC | Optional |
| R2 | SMN, BLM, RDM, PCT | Optional |

Confirm stays greyed out until you've picked at least one job for any tank or melee role you ticked.
Your jobs for the slot you get are shown on the roster, like `MT - @you (GNB/DRK)`.

The menu shows which roles are open or taken, and tells you where you'll end up before you confirm.

### Saved preference

Use `/setpreference` to save the roles (in order) and jobs you usually sign up with. It uses the same
menus as Sign up. After that, pressing **Sign up** on a run you haven't joined opens the menu already
filled in and shows where you'd land, so you just press **Confirm**, or change it first.
Run `/setpreference` again to change it, or press **Clear preference** to remove it.

Use `/myruns` any time to see every run you're currently signed up for — your pick, when it starts and
a link to its private channel — without the Merc Run ID, since that's only needed for `/managerun`.

`/setpreference` also sends a second message where you can pick one or more times (5 to 60 minutes
before a run starts) to get a DM reminder. It only reminds you about runs you're signed up for, and
saves as soon as you pick, so there's nothing else to confirm. Clear the selection to turn it off.
The DM names the run (amount, merc run type and clearee), shows the full date and links its private
channel so you can jump straight to it.

### Who gets priority

First come, first served. Nobody can take a slot away from someone who signed up before them.
A flex player can be moved to another of their roles to make room, but only if one is free.
If not, they keep their slot and the newer person goes on the waitlist.

When a slot opens up, the first person on the waitlist who wanted it is moved in automatically.

Changing your pick puts you at the back of the line.

### Example

1. User 1 picks H2, then R1, then R2. They get H2, their first choice.
2. User 2 picks only H2. User 1 moves to R1, their next choice.
3. User 3 picks only R1. User 1 moves to R2.
4. User 4 picks only R2. User 1 has nowhere else to go and signed up first, so User 4 is waitlisted.

```
H2 - @User2
R1 - @User3
R2 - @User1

Waitlist - @User4 (R2)
Bench - @User5 (MT/OT)
```

If User 3 leaves, User 1 moves back to R1 (a higher choice than R2) and User 4 gets R2.

## Test runs and managing runs

> `/createrun-test` is currently disabled. Test runs that were already posted still work.

`/createrun-test` works exactly like `/createrun`, except:

- The post starts with a random 6-digit **Merc Run ID** (under the ping):
  ```
  @here
  Merc Run ID: 482915
  5m M4S clear for Steph (NIN/SAM) - M1 @ Sunday, September 28, 2026 4:00 PM
  ...
  ```
- The private channel is called `merc-run-482915` instead.

Every run has a Merc Run ID. For `/createrun` runs it isn't shown on the post; you'll see it in the
private reply you get after creating the run, and `/managerun` lists your runs as you type.

To manage a run, use:

```
/managerun run_id:482915
```

You can start typing the ID or the run name and pick it from the list. You get these buttons:

| Button | What happens |
|---|---|
| **Completed** | The post is marked completed and sign-ups close. The run disappears from the `/managerun` list, the original post is deleted (the private channel's roster copy is kept as the record), and the private channel is deleted 3 hours later. The bot posts an @here "congrats, grab your screenshots" message in that private channel (and only there) with a live countdown to the deletion. |
| **Failed** | The post is marked failed and sign-ups close. The channel stays so you can plan a retry. |
| **Reschedule** | Enter a new time. The post is updated and sign-ups reopen. `/createrun` channels are renamed to the new day. |
| **Edit roster** | Add someone (pick them, then their roles and jobs like a normal sign-up), change someone's pick, or remove people. Flex moves, the waitlist and the private channel update just like normal sign-ups and leaves. "Add by name" lets you type a name instead of picking a Discord member — it still matches a real member if one exists, otherwise it's just shown as text. |
| **Edit details** | Change the amount, merc run type and/or time (time is optional — leave it blank to keep the current one). The roster, status and private channel membership are untouched; the channel is just renamed if the title or day changed. |
| **Delete run** | Deletes the post and the channel right away (asks you to confirm first). |

If a run's private channel is deleted, whether by the bot or by hand, the run is removed from `/managerun` too.
If the run **post** is deleted instead, the next action taken on it (from `/managerun` or a sign-up) reposts a
fresh copy automatically and keeps managing that one, since the bot can only edit messages it posted itself.
The pinned roster copy in the private channel is tracked and kept up to date independently of the run post
itself — including picking up a roster copy a run already had (from before this existed, or from an older
`/adoptrun`) instead of posting a duplicate, or posting one for the first time if it's missing. This is
checked once a minute for every run, not just when something changes, so an old `/adoptrun` with no roster
copy yet gets one without needing any action taken on it first. Admins can also run `/fixrun` to check every
run right away instead of waiting for the next check, or fill in its optional `run_id` to only check one run.
Either way, it only ever posts the plain roster message in the private channel — never a copy of the
Sign up/Leave/Manage Signup post, which only ever exists where `/createrun`, `/privaterun` or `/adoptrun`
posted it. `/fixrun` also checks every plain-text name (picked up from an `/adoptrun` post with no
`@mention`) against the server's member list. If a matching member is found, they're granted individual
access to the private channel and the roster is updated to `@mention` them instead of the plain name,
keeping their slot, roles and jobs as they were — unless they're somehow already on the roster under
their real account too, in which case only access is granted. It gives up re-checking a name after a
few `/fixrun` runs with no match, rather than searching forever.

### Adopting a manually posted run

If someone posts a run by hand (not through `/createrun`) with its own private channel, use `/adoptrun` in the
**same channel as the post** to bring it under the bot's management:

```
/adoptrun message_id:<the post's message ID> private_channel:#the-private-channel [time:...]
```

This attaches a Merc Run ID to it, so it gets DM reminders, the active-roster role, the "starting soon" ping,
and gets its private channel deleted automatically when marked completed — same as a run created with
`/createrun`. Since the bot can only edit messages it posted itself, it **reposts a fresh copy right below the
original** and manages that one from then on — the original post is left as-is and stops updating, so delete it
once you've checked the repost looks right. If `private_channel` is a different channel from the post, the
repost gets the usual Sign up/Leave/Manage Signup buttons there, plus its own pinned roster copy in the private
channel, same as `/createrun`. If `private_channel` is the **same** channel the post is in, the repost has no
buttons instead (a second buttoned post would just duplicate the roster already shown there) — sign-ups are
managed entirely through `/managerun`'s Edit roster for that run, and nobody's given individual access to that
channel, since it isn't being treated as a private channel at all.
Sign-ups, the waitlist and the bench are picked up from the original post (same recovery logic used if
`data/runs.json` is ever lost): real `@mentions` are picked up as normal, and a plain-text name (no `@mention`)
is kept too, shown under its name until you replace it with a real member using `/managerun`'s Edit roster.
Fill in `time` only if the post doesn't already contain a Discord timestamp (`<t:...>`).

Only the person who created the run, or anyone with the Manage Channels permission, can use `/managerun` on it.

If a run was adopted (or created) by mistake and you want the bot to stop managing it, use
`/removeadoptedrun run_id:482915`. This only forgets the run's Merc Run ID and saved roster from the bot — the
run post, its private channel, every message in it, and everyone's access are all left exactly as they are. It
asks you to confirm first, since the bot can't pick the run back up afterward (you'd need to `/adoptrun` it
again). Same permissions as `/managerun`.

The bot needs **Manage Channels** and **Manage Roles** to create run channels, and
**Mention @everyone, @here and All Roles** for the ping. The invite link above already includes them.
If you added the bot before, give its role those permissions in Server Settings. For
`ACTIVE_ROSTER_ROLE` below, the bot's own role also needs to sit **above** that role in
Server Settings → Roles, or it won't be able to add/remove it.

On servers set up for it (see `RUN_START_PING` in [src/config.js](src/config.js)), the bot pings
30 minutes before a run starts, e.g. "Run is starting in 30 minutes! PF will be up shortly." (with a
reminder underneath that the default PF Password is **8008**, bold/italic/underlined to stand out). If
`ACTIVE_ROSTER_ROLE` is also set up (below), it @mentions that run's actual active roster directly
instead of the role, so someone only waitlisted there (even if they're active in a different run)
never gets pinged by mistake. Otherwise it pings the configured role, or `@here` if there isn't one.

On servers set up for it (see `ACTIVE_ROSTER_ROLE` in [src/config.js](src/config.js)), the bot also
gives a role to whoever currently holds a slot in a run (not bench or waitlisted), and takes it away
the moment they're bumped, leave, or the run ends. This role is shared across every run in the
server, so being active in one run and waitlisted in another at the same time is expected to leave
you holding it — that's fine, since pings themselves (above) never rely on this role alone. Only
members who already pass that server's `signupRoles` rule (below) can ever hold it — a clearee added
via `/createrun`, or anyone picked up from a manually posted run via `/adoptrun`, never gets it just
for holding a slot if they don't have that role. DM reminders only go out to people who currently
hold a slot **in that specific run**, so bench/waitlisted mercs aren't bothered about a run they
might not play in.

Admins can use `/startprompt` to turn on a DM to the run's creator when its scheduled time arrives,
with **Completed**, **Failed** and **Reschedule** buttons — the same ones on `/managerun`, so they're
gated the same way. Clicking Reschedule just opens the usual reschedule form; nothing changes until
it's submitted.

- `/startprompt enable` / `/startprompt disable` turn it on or off for the server (off by default;
  see `START_PROMPT_ENABLED` in [src/config.js](src/config.js) for a code-level default instead).
- `/startprompt role` optionally also DMs everyone with a role, the same prompt the creator gets
  (nobody extra is DMed by default). The creator only ever gets it once, even if they also have
  that role. If the role can't already use `/createrun`, it's automatically granted access to it
  (same as `/permissions grant`). This needs the **Server Members Intent** turned on for the bot in
  the [Discord Developer Portal](https://discord.com/developers/applications) (Bot tab) — without
  it, the role option won't find anyone to DM.

The bot also rechecks every run's private channel once a minute and re-grants access to anyone who
should be able to see it but can't anymore (for example, if their permission was removed by hand) —
not just when they first sign up.

### Logging roster activity

Admins can use `/setlogchannel channel:#the-channel` to have the bot post a short log entry whenever
someone signs up, leaves, or changes their pick, whenever a manager adds, edits or removes someone
through `/managerun`'s Edit roster, and whenever a run is marked completed or failed — one line per
action (e.g. "✅ @user signed up for 482915 · 5m M4S clear as H2."). Nobody is pinged by these messages.
Run `/setlogchannel` again with no `channel` to turn logging off; if no log channel is set, nothing is
posted at all.

## Role restrictions

A server can limit who creates runs and who signs up. These rules are set in [src/config.js](src/config.js):

- `commandRoles`: only members with one of these roles can use `/createrun`, `/createrun-test`,
  `/privaterun`, `/adoptrun`, `/managerun` and `/runs`. **If a server doesn't set this, those
  commands are admin-only by default** (see `/permissions` below to open them up to others).
- `signupRoles`: only members with one of these roles can sign up. Anyone can still press Leave.
  Open to everyone if not set.
- `preferenceRoles`: only members with one of these roles can use `/setpreference`. Open to everyone
  if not set.
- `pingRole`: the role pinged on new run posts instead of `@here`.

Server admins (Administrator permission) can always use every command regardless of these rules.

An admin can also use `/permissions` to grant or revoke `/createrun`, `/privaterun`, `/adoptrun`,
`/managerun`, `/runs` or `/setpreference` access for a specific role or member, on top of (or
instead of) `commandRoles` — this is how you let non-admins use those commands without making
them admins. `/permissions list` shows every extra grant in the server.

## Commands

| Command | What it does |
|---|---|
| `/createrun` | Post a new run and create its private channel |
| `/createrun-test` | (Disabled) Same as `/createrun`, with the Merc Run ID on the post and a `merc-run-<id>` channel |
| `/privaterun` | Same as `/createrun`, but restricted to one channel and never pings anyone |
| `/adoptrun` | Attach a Merc Run ID to a manually posted run so the bot can manage it |
| `/removeadoptedrun` | Stop tracking a run without touching its post, channel, messages or permissions |
| `/managerun` | Mark a run completed or failed, reschedule it, edit its roster, or delete it |
| `/runs` | List current runs by name, clearee, date and a link to each private channel (no post content) |
| `/myruns` | See the runs you're signed up for, your pick, when they start and a link to each |
| `/settimezone` | Save or change your timezone |
| `/setpreference` | Save your usual roles and jobs so Sign up is filled in for you, and choose when you get DM reminders |
| `/help` | How to sign up for runs and which commands you can use in this server |
| `/permissions` | Admins only: grant or revoke a role/member's access to restricted commands |
| `/startprompt` | Admins only: turn the run-starting DM on/off, and optionally assign a role to ping |
| `/fixrun` | Admins only: scan every run (or just one, with `run_id`) and repost a missing roster copy in its private channel |
| `/setlogchannel` | Admins only: set or clear the channel roster activity gets logged to |

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
   View Channels, Send Messages, Read Message History, Manage Channels, Manage Roles and
   Mention Everyone. Open the link it gives you to add the bot to your server.

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

### Auto-update from GitHub

`npm start` runs [src/launcher.js](src/launcher.js), which starts the bot. Set `AUTO_UPDATE=true` in `.env`
and it checks GitHub when it starts and then every day at **3:00 AM New York time**
(change with `UPDATE_CHECK_TIME` and `UPDATE_CHECK_TIMEZONE`):

- No new commits: nothing happens and the bot keeps running.
- New commits: it pulls them, runs `npm install` if `package.json` changed, and restarts the bot.

This needs `git` and a folder that was set up with `git clone`. Your `.env` and `data/` are never touched.
If the update fails (for example because of local edits), it logs why and keeps the current version.

The bot's owner (a single hardcoded Discord user ID, `BOT_OWNER_ID` in [src/config.js](src/config.js)) can
also use `/botupdate` to trigger that same check right away instead of waiting for the daily one — nobody
else can use it, regardless of server or admin permissions, since it restarts the bot for every server at
once. Only works when started with `npm start` (through `src/launcher.js`); running `src/index.js` directly
has no auto-updater to ask.

### Hosting on Cybrancee

Cybrancee runs bots through a Pterodactyl panel. Setting names can differ slightly.
Follow these steps in order so the runs, sign-ups and saved timezones carry over.

1. **Push your latest code to GitHub** so the server gets it.
2. Create a **Node.js** bot server (Node 18 or newer).
3. In the **Startup** tab:
   - **Git repo address**: `https://github.com/stephk-p/merc-scheduling-bot.git`
   - **Branch**: `main`
   - **User uploaded files**: off (so the panel clones the repo)
   - **Main file** (bot JS file): `src/launcher.js`
4. Go to **Settings → Reinstall server** so it clones the repo. Don't start the server yet.
   (Reinstalling can wipe files, so always do it *before* the next steps, never after.)
5. **Stop the bot on your PC** (close its window). Two copies running on the same token would both
   answer every button click, and your PC's `data/` would stop matching the server's.
6. **Copy your `.env`**: in **Files**, click **New File**, name it `.env`, and paste in the contents of the
   `.env` on your PC. Then add these lines and save:
   ```
   AUTO_UPDATE=true
   UPDATE_CHECK_TIME=03:00
   UPDATE_CHECK_TIMEZONE=America/New_York
   ```
7. **Copy your `data/` folder**: in **Files**, click **Create Directory** and name it `data`. Open it,
   click **Upload**, and upload `runs.json` and `timezones.json` from the `data` folder on your PC.
   You can also use SFTP instead (connection details are under **Settings → SFTP Details**,
   use a program like WinSCP or FileZilla) and drag the whole `data` folder into the top folder.
8. Start the server. The console shows `[updater] Auto-update is on...`, the next check time,
   and then `Logged in as ...`. Check that `/managerun` lists your existing runs.

The top folder should end up looking like this:

```
.env
data/runs.json
data/timezones.json
data/preferences.json   (only once someone has used /setpreference)
src/...
package.json
```

After that, anything you push to `main` goes live at the next 3:00 AM check. To update right away,
restart the server from the panel. Don't run the bot on your PC with the same token while the server
is running. Download a copy of `data/` from the server now and then as a backup, and always before a reinstall.

### Something not working?

| Problem | Fix |
|---|---|
| `Missing DISCORD_TOKEN` | `.env` is missing or the token is blank. |
| `An invalid token was provided` | The token is wrong or was reset. Get a new one from the Bot tab. |
| `'node' is not recognized` | Install Node.js, then open a new terminal. |
| Commands don't show up | Set `GUILD_ID=all` and restart. Make sure the invite included `applications.commands`. |
| Commands show up twice | Restart the bot once and it cleans them up. |
| "Something went wrong" when signing up | The bot needs View Channels and Read Message History in that channel. |
| `/createrun` says it needs permissions | Give the bot's role Manage Channels and Manage Roles. |
| "Only members with the ... role" | That server limits the command or sign-ups to a role. See [Role restrictions](#role-restrictions). |
| The `@here` or role ping doesn't notify anyone | Give the bot's role **Mention @everyone, @here and All Roles**. |

Your token (`.env`) and the bot's saved data (`data/`) are in `.gitignore`, so they never get pushed to GitHub.

## Contact

stephk @ discord

## License

[MIT](LICENSE) © 2026 StephK
