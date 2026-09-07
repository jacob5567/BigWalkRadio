import { describe, expect, it } from 'vitest';
import { albumKey, formatTimeOfDay, parseTrackName } from '../src/core/naming';

describe('parseTrackName', () => {
  it('reads the album, time and title off a soundtrack filename', () => {
    const p = parseTrackName('aksfx - Radio- Lobby (Original Music from Big Walk) - 02 -7-12am- Leitmotif.flac');
    expect(p.album).toBe('Lobby');
    expect(p.timeOfDayMinutes).toBe(7 * 60 + 12);
    expect(p.title).toBe('Leitmotif');
  });

  it('treats 12am as midnight and 12pm as noon', () => {
    expect(parseTrackName('x -12-00am- Motif.flac').timeOfDayMinutes).toBe(0);
    expect(parseTrackName('x -12-30pm- Noon.flac').timeOfDayMinutes).toBe(12 * 60 + 30);
  });

  it('handles afternoon stamps', () => {
    const p = parseTrackName('aksfx - Radio- Blueprint (Original Music from Big Walk) - 04 -10-51pm- Glomo.flac');
    expect(p.timeOfDayMinutes).toBe(22 * 60 + 51);
    expect(p.title).toBe('Glomo');
  });

  it('parses an album with no timestamps', () => {
    const p = parseTrackName('aksfx - B-Sides (Original Music from Big Walk) - 04 Credits.flac');
    expect(p.album).toBe('B-Sides');
    expect(p.timeOfDayMinutes).toBeNull();
    expect(p.title).toBe('Credits');
  });

  it('falls back to a plain title for unrelated files', () => {
    const p = parseTrackName('my song.mp3');
    expect(p.album).toBeNull();
    expect(p.timeOfDayMinutes).toBeNull();
    expect(p.title).toBe('my song');
  });

  it('rejects nonsense times', () => {
    expect(parseTrackName('track -13-99am- x.mp3').timeOfDayMinutes).toBeNull();
  });
});

describe('albumKey', () => {
  it('matches across punctuation and case', () => {
    expect(albumKey('Fourth Space')).toBe(albumKey('fourth-space'));
    expect(albumKey('B-Sides')).toBe('bsides');
  });
});

describe('formatTimeOfDay', () => {
  it('renders 12-hour times the way the tracks are named', () => {
    expect(formatTimeOfDay(0)).toBe('12:00am');
    expect(formatTimeOfDay(7 * 60 + 12)).toBe('7:12am');
    expect(formatTimeOfDay(22 * 60 + 51)).toBe('10:51pm');
    expect(formatTimeOfDay(12 * 60)).toBe('12:00pm');
  });
});
