// Starts the bot and, with AUTO_UPDATE=true, checks GitHub for new commits every
// UPDATE_CHECK_HOURS (default 24). If there are any, it pulls them, reinstalls packages if they
// changed, and restarts the bot. If nothing changed, the bot keeps running untouched.
import 'dotenv/config';
import { exec, execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT_FILE = path.join(ROOT, 'src', 'index.js');
const AUTO_UPDATE = /^(1|true|yes|on)$/i.test(process.env.AUTO_UPDATE ?? '');
const CHECK_HOURS = Number(process.env.UPDATE_CHECK_HOURS) > 0 ? Number(process.env.UPDATE_CHECK_HOURS) : 24;

const run = promisify(execFile);
const sh = promisify(exec);
const git = async (...args) => (await run('git', args, { cwd: ROOT })).stdout.trim();
const log = (msg) => console.log(`[updater] ${msg}`);

let bot = null;
let restarting = false;
let shuttingDown = false;

function startBot() {
  bot = spawn(process.execPath, [BOT_FILE], { cwd: ROOT, stdio: 'inherit' });
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

/** Pulls new commits if GitHub has any. Returns true if the code changed. */
async function update() {
  try {
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch === 'HEAD') {
      log('Not on a branch, so auto-update is skipped.');
      return false;
    }
    await git('fetch', '--quiet', 'origin', branch);
    const behind = Number(await git('rev-list', '--count', `HEAD..origin/${branch}`));
    if (!behind) {
      log(`No changes on GitHub (${branch}). Not restarting.`);
      return false;
    }

    const before = await git('rev-parse', 'HEAD');
    log(`${behind} new commit(s) on GitHub. Updating...`);
    await git('merge', '--ff-only', `origin/${branch}`);
    const changed = await git('diff', '--name-only', before, 'HEAD');
    if (/^package(-lock)?\.json$/m.test(changed)) {
      log('Packages changed. Running npm install...');
      await sh('npm install --omit=dev --no-audit --no-fund', { cwd: ROOT });
    }
    log(`Updated to ${(await git('rev-parse', '--short', 'HEAD'))}.`);
    return true;
  } catch (err) {
    // Not a git clone, no git installed, local edits in the way, network down, ...
    log(`Update check failed, keeping the current version: ${err.stderr?.trim() || err.message}`);
    return false;
  }
}

async function checkAndRestart() {
  if (!(await update())) return;
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
  log(`Auto-update is on. Checking GitHub now and every ${CHECK_HOURS} hour(s).`);
  await update();
  setInterval(checkAndRestart, CHECK_HOURS * 60 * 60 * 1000);
}
startBot();
