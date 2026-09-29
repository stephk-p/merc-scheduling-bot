// Per-server rules. Servers that aren't listed here have no role restrictions.
//
//   commandRoles - only members with at least one of these roles can use
//                  /createrun, /createrun-test and /managerun
//   signupRoles  - only members with at least one of these roles can sign up for runs
//                  (anyone can still press Leave)
//   pingRole     - role pinged at the top of new run posts (servers without one get @here)
export const SERVER_RULES = {
  '1529143174872825916': {
    commandRoles: ['1551648248593256498'],
    signupRoles: ['1529562550348288040'],
    pingRole: '1529562550348288040',
  },
};

/** Commands that are limited by `commandRoles`. */
export const RESTRICTED_COMMANDS = ['createrun', 'createrun-test', 'managerun'];
