// Starts the bot and, with AUTO_UPDATE=true, checks GitHub for new commits every day at
// UPDATE_CHECK_TIME in UPDATE_CHECK_TIMEZONE (default 03:00 America/New_York). If there are any, it
// pulls them, reinstalls packages if they changed, and restarts the bot. Otherwise nothing happens.
import 'dotenv/config';
import { exec, execFile, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DateTime } from 'luxon';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT_FILE = path.join(ROOT, 'src', 'index.js');
// Written when /botupdate triggers an update, so the restarted bot can confirm it's back up.
const PENDING_FILE = path.join(ROOT, 'data', 'botupdate.json');
const AUTO_UPDATE = /^(1|true|yes|on)$/i.test(process.env.AUTO_UPDATE ?? '');
const CHECK_ZONE = process.env.UPDATE_CHECK_TIMEZONE || 'America/New_York';
const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(process.env.UPDATE_CHECK_TIME ?? '');
const [CHECK_HOUR, CHECK_MINUTE] = timeMatch && +timeMatch[1] < 24 && +timeMatch[2] < 60
  ? [+timeMatch[1], +timeMatch[2]]
  : [3, 0];

const run = promisify(execFile);
const sh = promisify(exec);
const git = async (...args) => (await run('git', args, { cwd: ROOT })).stdout.trim();
const log = (msg) => console.log(`[updater] ${msg}`);

let bot = null;
let restarting = false;
let shuttingDown = false;

function startBot() {
  // fork() (rather than spawn()) gives the bot process an IPC channel back to this launcher, so
  // /botupdate can ask for an on-demand update check without waiting for the daily schedule.
  bot = fork(BOT_FILE, { cwd: ROOT, stdio: 'inherit' });
  bot.on('message', (msg) => {
    if (msg?.type !== 'check-update') return;
    log(`Manual update check requested${msg.by ? ` by ${msg.by}` : ''}.`);
    checkAndRestart({ id: msg.id, by: msg.by, token: msg.token, appId: msg.appId });
  });
  bot.on('exit', (code, signal) => {
    bot = null;
    if (restarting) return;
    // The bot stopped on its own (crash, bad token, etc.): stop too, so the host sees it.
    process.exit(shuttingDown ? 0 : (code ?? (signal ? 1 : 0)));
  });
}

function stopBot() {
  return new Promise((resolve) => {
    if (!bot) return resolve();
    bot.once('exit', resolve);
    bot.kill('SIGTERM');
  });
}

/**
 * Checks GitHub and pulls new commits if there are any.
 * @returns {Promise<{ status: 'none'|'updated'|'failed'|'skipped', branch?: string, from?: string,
 *   to?: string, behind?: number, commits?: string[], error?: string }>}
 */
async function update() {
  try {
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch === 'HEAD') {
      log('Not on a branch, so auto-update is skipped.');
      return { status: 'skipped', error: 'Not on a branch, so updates are skipped.' };
    }
    await git('fetch', '--quiet', 'origin', branch);
    const behind = Number(await git('rev-list', '--count', `HEAD..origin/${branch}`));
    const before = await git('rev-parse', '--short', 'HEAD');
    if (!behind) {
      log(`No changes on GitHub (${branch}). Not restarting.`);
      return { status: 'none', branch, to: before };
    }

    const beforeFull = await git('rev-parse', 'HEAD');
    const commits = (await git('log', '--format=%s', '-n', '5', `HEAD..origin/${branch}`)).split('\n').filter(Boolean);
    log(`${behind} new commit(s) on GitHub. Updating...`);
    await git('merge', '--ff-only', `origin/${branch}`);
    const changed = await git('diff', '--name-only', beforeFull, 'HEAD');
    if (/^package(-lock)?\.json$/m.test(changed)) {
      log('Packages changed. Running npm install...');
      await sh('npm install --omit=dev --no-audit --no-fund', { cwd: ROOT });
    }
    const after = await git('rev-parse', '--short', 'HEAD');
    log(`Updated to ${after}.`);
    return { status: 'updated', branch, from: before, to: after, behind, commits };
  } catch (err) {
    // Not a git clone, no git installed, local edits in the way, network down, ...
    const error = err.stderr?.trim() || err.message;
    log(`Update check failed, keeping the current version: ${error}`);
    return { status: 'failed', error };
  }
}

/**
 * `request` is set for a manual /botupdate: the result is sent back to the bot so it can reply, and
 * when it updated, the request is saved so the restarted bot can confirm it came back up.
 */
async function checkAndRestart(request = null) {
  const result = await update();
  if (request) {
    if (result.status === 'updated' && request.token) {
      fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
      fs.writeFileSync(PENDING_FILE, JSON.stringify({ ...request, ...result }));
    }
    try {
      bot?.send({ type: 'update-result', id: request.id, ...result });
    } catch {
      // The bot already went away; nothing to tell.
    }
  }
  if (result.status !== 'updated') return;
  // Gives the bot a moment to post "restarting" before it's stopped.
  if (request) await new Promise((resolve) => setTimeout(resolve, 2000));
  log('Restarting the bot...');
  restarting = true;
  await stopBot();
  restarting = false;
  startBot();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    if (bot) bot.kill(signal);
    else process.exit(0);
  });
}

if (AUTO_UPDATE) {
  if (!DateTime.local().setZone(CHECK_ZONE).isValid) throw new Error(`Unknown UPDATE_CHECK_TIMEZONE: ${CHECK_ZONE}`);
  const nextCheck = () => {
    const now = DateTime.now().setZone(CHECK_ZONE);
    let next = now.set({ hour: CHECK_HOUR, minute: CHECK_MINUTE, second: 0, millisecond: 0 });
    if (next <= now) next = next.plus({ days: 1 });
    return next;
  };
  const schedule = () => {
    const next = nextCheck();
    log(`Next GitHub check: ${next.toFormat('ccc LLL d, HH:mm ZZZZ')}.`);
    setTimeout(async () => {
      await checkAndRestart();
      schedule();
    }, next.toMillis() - Date.now());
  };
  log('Auto-update is on. Checking GitHub now.');
  await update();
  schedule();
}
startBot();
