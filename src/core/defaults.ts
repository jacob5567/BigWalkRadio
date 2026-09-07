import { DEFAULT_BLEND_SECONDS } from './schedule';
import { STATION_PRESETS } from './presets';
import type { Settings, Station } from './types';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'real',
  gameDayMinutes: 24,
  compressTrackTimeline: false,
  channel: 1,
  volume: 0.8,
  powered: false,
  blendSeconds: DEFAULT_BLEND_SECONDS,
};

/**
 * The dial, exactly as generated from what is on the server: one channel per
 * album, dayparted where the filenames carry times and shuffled where they
 * don't.
 */
export function makeDefaultStations(): Station[] {
  return STATION_PRESETS.map((station) => ({
    ...station,
    programs: station.programs.map((program) => ({ ...program, trackIds: [...program.trackIds] })),
  }));
}
