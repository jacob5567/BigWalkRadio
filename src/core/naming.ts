export interface ParsedTrackName {
  /** Album/station the file came from, e.g. "Lobby", if the name says so. */
  album: string | null;
  /** Time of day stamped into the filename, in minutes past midnight. */
  timeOfDayMinutes: number | null;
  /** Track title with the album prefix, disc number and timestamp stripped off. */
  title: string;
}

const EXTENSION = /\.[^./\\]+$/;
/** "aksfx - Radio- Lobby (Original Music from Big Walk) - 02 -7-12am- Leitmotif" */
const ALBUM = /(?:radio[-:]\s*)?(.+?)\s*\(original music from big walk\)/i;
/** "-7-12am-" or "-12-00am-", with either dashes or colons. */
const TIMESTAMP = /[-\s(\[](\d{1,2})[-:.](\d{2})\s*(am|pm)[-\s)\]]/i;
const LEADING_INDEX = /^\s*\d{1,3}(?:\s*[-.)]|\b)\s+/;

export function to24Hour(hour12: number, minute: number, meridiem: string): number {
  const h = hour12 % 12;
  const base = meridiem.toLowerCase() === 'pm' ? h + 12 : h;
  return base * 60 + minute;
}

/**
 * Pulls the station and time-of-day out of a filename. The Big Walk soundtrack
 * stamps both into every track name; anything else falls back to a plain title.
 */
export function parseTrackName(fileName: string): ParsedTrackName {
  const base = fileName.replace(EXTENSION, '');

  let album: string | null = null;
  const albumMatch = base.match(ALBUM);
  if (albumMatch?.[1]) {
    album = albumMatch[1].replace(/^aksfx\s*-\s*/i, '').replace(/^radio[-:]\s*/i, '').trim() || null;
  }

  let timeOfDayMinutes: number | null = null;
  let title = base;
  const timeMatch = base.match(TIMESTAMP);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (hour >= 1 && hour <= 12 && minute < 60) {
      timeOfDayMinutes = to24Hour(hour, minute, timeMatch[3]!);
      title = base.slice(timeMatch.index! + timeMatch[0].length);
    }
  } else if (albumMatch) {
    title = base.slice(albumMatch.index! + albumMatch[0].length);
  }

  title = title.replace(/^\s*[-–—]\s*/, '').replace(LEADING_INDEX, '').trim();
  return { album, timeOfDayMinutes, title: title || base };
}

/** Loose key for matching a parsed album against a station preset. */
export function albumKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function minutesToHour(minutes: number): number {
  return (((minutes / 60) % 24) + 24) % 24;
}

export function formatTimeOfDay(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const meridiem = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm}${meridiem}`;
}
