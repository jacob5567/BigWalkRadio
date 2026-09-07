import { DEFAULT_BLEND_SECONDS } from './schedule';
import { STATION_PRESETS } from './presets';
import type { Settings, Station } from './types';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'real',
  gameDayMinutes: 24,
  compressTrackTimeline: false,
  frequency: 100.9,
  volume: 0.8,
  powered: false,
  blendSeconds: DEFAULT_BLEND_SECONDS,
};

/**
 * The eighth slot on the dial. The soundtrack release only ships seven
 * time-stamped albums, so this one starts empty for the listener to fill.
 */
export const CUSTOM_STATION_ID = 'st-custom';

/**
 * Starter dial: the album schedules, with every daypart empty until the
 * listener imports their own audio.
 */
export function makeDefaultStations(): Station[] {
  const presets: Station[] = STATION_PRESETS.map((s) => ({
    ...s,
    programs: s.programs.map((p) => ({ ...p, trackIds: [...p.trackIds] })),
  }));
  presets.push({
    id: CUSTOM_STATION_ID,
    name: 'Open Frequency',
    frequency: 88.1,
    programs: [{ id: `${CUSTOM_STATION_ID}-p1`, name: 'Continuous', startHour: 0, trackIds: [] }],
  });
  return presets.sort((a, b) => a.frequency - b.frequency);
}
