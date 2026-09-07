import type { DialConfig, Station } from './types';

export const DEFAULT_DIAL: DialConfig = {
  min: 1,
  max: 8,
  // Channels sit one apart, so the dial is clean on a whole number and mostly
  // hiss halfway between two of them.
  halfWidth: 0.18,
  capture: 2.2,
  staticFalloff: 1.6,
};

export interface StationSignal {
  station: Station;
  /** How many channels away from where the dial is sitting. */
  distance: number;
  /** Signal strength ignoring neighbours, 0..1. */
  raw: number;
  /** Audible gain after the capture effect, 0..1. */
  gain: number;
}

export interface DialState {
  channel: number;
  signals: StationSignal[];
  /** Strongest station, if anything is receivable at all. */
  locked: StationSignal | null;
  /** How cleanly we're tuned in, 0..1. */
  lock: number;
  /** Gain for the inter-station hiss, 0..1. */
  staticGain: number;
}

/** Half strength at `halfWidth` channels off, falling off fast after that. */
function rawSignal(distance: number, halfWidth: number): number {
  const x = distance / Math.max(1e-6, halfWidth);
  return Math.pow(2, -(x * x));
}

/** Below this a station isn't worth spending an audio element on. */
export const AUDIBLE_THRESHOLD = 0.02;

export function readDial(
  stations: readonly Station[],
  channel: number,
  config: DialConfig = DEFAULT_DIAL,
): DialState {
  const signals: StationSignal[] = stations.map((station) => {
    const distance = Math.abs(station.channel - channel);
    return { station, distance, raw: rawSignal(distance, config.halfWidth), gain: 0 };
  });

  let best: StationSignal | null = null;
  for (const s of signals) if (!best || s.raw > best.raw) best = s;

  const lock = best ? best.raw : 0;
  if (best && lock > 0) {
    // Capture effect: the strongest signal squashes anything nearby, the way a
    // real FM receiver locks on rather than mixing two stations evenly.
    for (const s of signals) s.gain = s.raw * Math.pow(s.raw / lock, config.capture);
  }

  return {
    channel,
    signals,
    locked: best && best.raw > AUDIBLE_THRESHOLD ? best : null,
    lock,
    staticGain: Math.pow(1 - lock, config.staticFalloff),
  };
}

/** Off-station signal loses its highs before it loses its volume. */
export function lowpassHz(gain: number): number {
  const g = Math.min(1, Math.max(0, gain));
  return 600 * Math.pow(20000 / 600, g);
}
