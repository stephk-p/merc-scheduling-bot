# Privacy Policy

*Last updated: 09-29-2026*

This Privacy Policy explains what data the Discord bot "merc-scheduling-bot" (the "Bot")
collects and how it's used.

## Information the Bot stores

The Bot keeps one file on the machine it runs on. For each user who sets a timezone, it
stores:
- The user's Discord user ID
- The timezone they chose (for example, `America/New_York`)

A timezone is saved when a user runs `/settimezone`, or fills in the `timezone` option
on `/createrun`. Nothing is saved for users who never do either.

The Bot has no database for runs or sign-ups. The roster lives only in the run post
itself, which is a normal Discord message in your server.

## Information the Bot processes but does not store

- **Command input.** The amount, text, time, clearee and role entered in `/createrun`
  are used to build the run post. They aren't stored anywhere except the post itself.
- **User IDs and mentions.** When a user signs up for a role, their mention (which
  contains their Discord user ID) is added to the run post. When a user leaves, it is
  removed. The Bot reads the post to see who holds which role, and doesn't keep a
  separate copy.
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
with permission deletes them, and deleting a post removes its roster.

To have your saved timezone deleted, use the contact method listed under Contact below.

## Where data is stored

Saved timezones are stored in a local file (`data/timezones.json`) on the machine that
runs the Bot. They are not sent to any analytics service or data broker.

If you run your own copy of the Bot from this source code, you are the operator of that
copy and are responsible for the data it stores.

## Your rights

You can change your saved timezone at any time with `/settimezone`, stop using the Bot at
any time, or ask the operator to delete your saved timezone. Server administrators can
remove the Bot from their server at any time.

## Changes to this policy

This policy may be updated from time to time. Continued use of the Bot after a change
means you accept the updated policy.

## Contact

Questions about this policy: stephk @ discord
