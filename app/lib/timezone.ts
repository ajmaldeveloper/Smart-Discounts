/**
 * Converts a wall-clock date+time as understood in a given IANA
 * timezone (e.g. a merchant typing "6:30 PM" while the shop's timezone
 * is "America/New_York") into the correct UTC instant. Shopify's own
 * discount startsAt/endsAt are literal UTC timestamps it enforces
 * as-is — without this conversion, "6:30 PM" typed in any zone other
 * than UTC would silently launch at the wrong real-world time.
 *
 * Standard two-pass trick (no dependency needed): guess the offset is
 * zero, format that guess back through the target zone to see what
 * offset it actually implies, then correct for it. Handles DST
 * correctly because the offset is read off a moment very close to the
 * actual instant, not a fixed year-round constant.
 */
export function zonedTimeToUtcIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = (time || "00:00").split(":").map(Number);
  if (!year || !month || !day) return "";

  const naiveUtcMs = Date.UTC(year, month - 1, day, hour || 0, minute || 0);
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(naiveUtcMs), timeZone);
  return new Date(naiveUtcMs - offsetMinutes * 60000).toISOString();
}

/** The inverse: splits a stored UTC ISO instant back into the date/time it displays as in a given IANA timezone — so re-opening a schedule shows the same wall-clock values the merchant originally entered. */
export function utcIsoToZonedParts(iso: string, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };

  const parts = partsOf(new Date(iso), timeZone);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = partsOf(date, timeZone);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (asUtc - date.getTime()) / 60000;
}

function calendarDayKey(date: Date, timeZone: string): string {
  const parts = partsOf(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** "Today"/"Yesterday"/"Tomorrow" when `date` falls on that calendar day in `timeZone` (relative to right now), else null so the caller can fall back to a formatted date. Comparing calendar days (not a raw 24h/48h distance) keeps this correct near midnight in the given zone. */
export function relativeDayLabel(date: Date, timeZone: string): string | null {
  const now = new Date();
  const targetKey = calendarDayKey(date, timeZone);

  if (targetKey === calendarDayKey(now, timeZone)) return "Today";
  if (targetKey === calendarDayKey(new Date(now.getTime() - 86400000), timeZone)) return "Yesterday";
  if (targetKey === calendarDayKey(new Date(now.getTime() + 86400000), timeZone)) return "Tomorrow";

  return null;
}

function partsOf(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const result: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") result[part.type] = part.value;
  }
  return result;
}
