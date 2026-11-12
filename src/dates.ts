// Deterministic date handling. The model never works out what "Monday" or "3 November" means: code does,
// in the user's own timezone, and passes the result to the model as plain dates.
import * as chrono from "chrono-node";

export type Clock = { now: Date; tz: string };

/** YYYY-MM-DD for an instant, as a calendar day in `tz`. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "Wednesday, 11 November 2026" in `tz`. */
export function longDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
}

/** Offset of `tz` from UTC in minutes at instant `d` (e.g. +330 for Asia/Kolkata). */
export function tzOffsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - d.getTime()) / 60000);
}

export function isValidTz(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type DateMention = {
  text: string;
  date: string;
  range?: { from: string; to: string };
  /** Other days the phrase could mean. "Last Tuesday" said on a Wednesday is yesterday to some people, 8 days ago to others. */
  alternatives?: string[];
};

const FUTURE_WORDS = /\b(next|coming|upcoming|tomorrow|will|plan(?:ning)?|going to|later)\b/i;

/**
 * Find date references in a message and resolve each to a local calendar day (or range).
 * Chat about memory is about the past, so a bare weekday or date that lands in the future
 * ("on Monday", "on 3 November") is moved back one week / one year unless the text says "next".
 */
export function resolveDates(text: string, clock: Clock): DateMention[] {
  const ref = { instant: clock.now, timezone: tzOffsetMinutes(clock.now, clock.tz) };
  const today = localDate(clock.now, clock.tz);
  const out: DateMention[] = [];
  for (const r of chrono.en.GB.parse(text, ref)) {
    // "Monday.com" is a product, not a weekday. Found by a test: it put "Monday = 9 Nov" into a pricing turn.
    // Only real domain endings, lowercase, so "Monday.Can you remind me?" (no space after the full stop) stays a date.
    if (/^\.(?:com|io|co|app|ai|net|org|dev|so|xyz|in)\b/.test(text.slice(r.index + r.text.length))) continue;
    let start = r.start.date();
    const wantsFuture = FUTURE_WORDS.test(r.text) || FUTURE_WORDS.test(text.slice(Math.max(0, r.index - 12), r.index));
    if (!wantsFuture && localDate(start, clock.tz) > today) {
      const shifted = new Date(start);
      if (r.start.isCertain("weekday") && !r.start.isCertain("day")) shifted.setUTCDate(shifted.getUTCDate() - 7);
      else if (!r.start.isCertain("year")) shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
      start = shifted;
    }
    const mention: DateMention = { text: r.text, date: localDate(start, clock.tz) };
    if (/\blast\s+(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(r.text)) mention.alternatives = [addDays(mention.date, -7)];
    if (r.end) mention.range = { from: mention.date, to: localDate(r.end.date(), clock.tz) };
    // "last week" / "this month" come back as a single day; treat week/month words as ranges.
    if (!r.end && /\bweek\b/i.test(r.text)) mention.range = { from: mention.date, to: addDays(mention.date, 6) };
    // "This week" in chat means the last seven days, not the calendar week that started on Sunday.
    if (/\bthis week\b/i.test(r.text)) mention.range = { from: addDays(today, -6), to: today };
    // "last month", or a bare month name ("in August"), means the whole month, not its first day.
    const monthOnly = r.start.isCertain("month") && !r.start.isCertain("day");
    if (!r.end && (/\bmonth\b/i.test(r.text) || monthOnly)) mention.range = { from: mention.date.slice(0, 8) + "01", to: endOfMonth(mention.date) };
    out.push(mention);
  }
  return out;
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function endOfMonth(day: string): string {
  const d = new Date(day.slice(0, 8) + "01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Human-friendly day for prompts and UI: "Monday 9 Nov 2026". */
export function prettyDay(day: string): string {
  const d = new Date(day + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(d);
}
