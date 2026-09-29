# Privacy Policy

*Last updated: 09-29-2026*

This Privacy Policy explains what data the Discord bot "merc-scheduling-bot" (the "Bot")
collects and how it's used.

## Information the Bot stores

The Bot keeps two files on the machine it runs on.

**Saved timezones.** For each user who sets a timezone, it stores:
- The user's Discord user ID
- The timezone they chose (for example, `America/New_York`)

A timezone is saved when a user runs `/settimezone`, or fills in the `timezone` option
on `/createrun`. Nothing is saved for users who never do either.

**Run sign-ups.** For each run post, it stores:
- The run post's message ID, the post's first line (amount, text, time and clearee)
  and the run's start time
- For each person signed up: their Discord user ID, the roles they picked, whether they
  picked BENCH, and the order they signed up in

This lets the Bot place flex players fairly and keep the order after a restart.

## Information the Bot processes but does not store

- **Command input.** The amount, text, time, clearee and role entered in `/createrun`
  are used to build the run post. Apart from the run sign-up record described above,
  they're not stored.
- **User IDs and mentions.** When a user signs up, their mention (which contains their
  Discord user ID) is added to the run post. When a user leaves, it is removed from the
  post and from the run's saved sign-ups.
- **Server and channel IDs.** The Bot uses these to register its commands and to edit
  run posts. They are not stored.

The Bot does not read message content other than its own run posts. It does not request
the Message Content, Server Members or Presence intents.

## How this information is used

Only to run the Bot's features: creating run posts, managing sign-ups, and converting
times into the right timezone. It is not used for advertising, profiling, or any purpose
unrelated to the Bot's features.

## Data sharing

This data is not sold, rented, or shared with third parties, except where required by
law. All interactions pass through Discord and are also covered by
[Discord's Privacy Policy](https://discord.com/privacy).

## Data retention and deletion

A saved timezone is kept until the user changes it or asks for it to be deleted.
Removing the Bot from a server doesn't delete saved timezones, because they belong to
users rather than servers. Run posts are normal Discord messages. They stay until someone
with permission deletes them.

Run sign-ups are deleted automatically 14 days after the run's start time. A user's
sign-up is removed as soon as they press Leave.

To have your saved data deleted, use the contact method listed under Contact below.

## Where data is stored

Saved timezones and run sign-ups are stored in local files (`data/timezones.json` and
`data/runs.json`) on the machine that runs the Bot. They are not sent to any analytics
service or data broker.

If you run your own copy of the Bot from this source code, you are the operator of that
copy and are responsible for the data it stores.

## Your rights

You can change your saved timezone at any time with `/settimezone`, stop using the Bot at
any time, leave a run with the Leave button, or ask the operator to delete your saved data. Server administrators can
remove the Bot from their server at any time.

## Changes to this policy

This policy may be updated from time to time. Continued use of the Bot after a change
means you accept the updated policy.

## Contact

Questions about this policy: stephk @ discord
