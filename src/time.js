import * as chrono from 'chrono-node';
import { DateTime, FixedOffsetZone } from 'luxon';

/**
 * Parse a human time like "sept 28 @ 4 PM" in the given IANA zone into a unix timestamp (seconds).
 * Also accepts an existing Discord timestamp (<t:1234567890:F>) or a raw unix timestamp.
 * If the text contains an explicit timezone (e.g. "4pm EST"), that wins over `zone`.
 *
 * `date` is the same moment in the timezone the time was written in, so the day matches what
 * the user typed.
 *
 * @returns {{ ts: number, date: DateTime } | { error: string }}
 */
export function parseTime(input, zone) {
  const raw = input.trim();

  // Rejects anything already in the past, whether typed, pasted as a Discord timestamp, or parsed.
  const checkFuture = (result) =>
    (result.ts * 1000 <= Date.now()
      ? { error: "That time has already passed. Enter a date and time in the future." }
      : result);

  const stamp = raw.match(/^<t:(-?\d+)(?::[tTdDfFR])?>$/) || raw.match(/^(\d{9,11})$/);
  if (stamp) {
    const ts = Number(stamp[1]);
    return checkFuture({ ts, date: DateTime.fromSeconds(ts, { zone: zone ?? 'UTC' }) });
  }

  const cleaned = raw.replace(/@/g, ' at ').replace(/\s+/g, ' ');
  const now = zone ? DateTime.now().setZone(zone) : DateTime.utc();
  const results = chrono.parse(
    cleaned,
    { instant: now.toJSDate(), timezone: now.offset },
    { forwardDate: true },
  );

  if (!results.length) {
    return { error: `Couldn't understand the time \`${raw}\`. Try something like \`sept 28 @ 4 PM\`.` };
  }

  const start = results[0].start;

  if (start.isCertain('timezoneOffset')) {
    const ts = Math.floor(start.date().getTime() / 1000);
    const offset = FixedOffsetZone.instance(start.get('timezoneOffset') ?? 0);
    return checkFuture({ ts, date: DateTime.fromSeconds(ts, { zone: offset }) });
  }

  if (!zone) {
    return {
      error:
        "I don't know your timezone yet. Set it once with `/settimezone`, " +
        'or fill in the `timezone` option on `/createrun`.',
    };
  }

  const dt = DateTime.fromObject(
    {
      year: start.get('year'),
      month: start.get('month'),
      day: start.get('day'),
      hour: start.get('hour'),
      minute: start.get('minute'),
      second: 0,
    },
    { zone },
  );

  if (!dt.isValid) return { error: `That time doesn't exist in ${zone}.` };
  return checkFuture({ ts: Math.floor(dt.toSeconds()), date: dt });
}
