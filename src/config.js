// Per-server rules. Servers that aren't listed here have no role restrictions.
//
//   commandRoles - only members with at least one of these roles can use
//                  /createrun, /createrun-test, /managerun and /runs
//   signupRoles  - only members with at least one of these roles can sign up for runs
//                  (anyone can still press Leave)
//   preferenceRoles - only members with at least one of these roles can use /setpreference
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
  '1529143174872825916': { roleId: '1529562550348288040', minutesBefore: 30 },
};

/** Used for servers not listed in RUN_START_PING above. */
export const DEFAULT_RUN_START_PING = { roleId: null, minutesBefore: 30 };

/** Commands that are limited by `commandRoles`. */
export const RESTRICTED_COMMANDS = ['createrun', 'createrun-test', 'managerun', 'runs'];
