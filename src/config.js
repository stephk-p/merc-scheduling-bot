// Per-server rules. Servers that aren't listed here get the defaults noted below.
//
//   commandRoles - only members with at least one of these roles can use
//                  /createrun, /createrun-test, /managerun and /runs.
//                  Not set: only server admins (plus anyone granted access via /permissions).
//   signupRoles  - only members with at least one of these roles can sign up for runs
//                  (anyone can still press Leave). Not set: open to everyone.
//   preferenceRoles - only members with at least one of these roles can use /setpreference.
//                     Not set: open to everyone.
//   pingRole     - role pinged at the top of new run posts (servers without one get @here)
export const SERVER_RULES = {
  '1529143174872825916': {
    commandRoles: ['1551648248593256498'],
    signupRoles: ['1529562550348288040'],
    preferenceRoles: ['1529562550348288040'],
    pingRole: '1529562550348288040',
  },
};

// Per-server "run starting soon" ping, posted in the run's private channel.
//   roleId        - role pinged (servers without one get @here)
//   minutesBefore - how long before the run's start time the ping goes out
export const RUN_START_PING = {
  '1529143174872825916': { roleId: '1555042669154275348', minutesBefore: 30 },
};

/** Used for servers not listed in RUN_START_PING above. */
export const DEFAULT_RUN_START_PING = { roleId: null, minutesBefore: 30 };

// Per-server role given to whoever currently holds a slot (not bench/waitlisted) in a run, so the
// "run starting soon" ping above only reaches people who can actually see the channel and are
// really playing. Added/removed automatically as the roster changes.
export const ACTIVE_ROSTER_ROLE = {
  '1529143174872825916': '1555042669154275348',
};

// Servers where the run creator gets a private DM (with Completed/Failed/Reschedule buttons) when
// a run's scheduled time arrives. Off by default; add `'<guildId>': true` to turn it on somewhere.
export const START_PROMPT_ENABLED = {};

/** Commands that are limited by `commandRoles`. */
export const RESTRICTED_COMMANDS = ['createrun', 'createrun-test', 'managerun', 'runs'];
