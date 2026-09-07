/**
 * The switch has nine positions: 0 is off, then one per channel. Every change
 * is covered by a burst of static, the way twisting a dial between stations
 * does, so nothing ever cuts straight from one track to another.
 */
export interface TuneConfig {
  /** Milliseconds of static covering the change. */
  staticMs: number;
  /** Milliseconds for the new channel to come up under the static. */
  fadeMs: number;
}

export const DEFAULT_TUNE: TuneConfig = { staticMs: 240, fadeMs: 220 };

export interface TuneState {
  /** What the selected channel should be playing at, 0..1. */
  stationGain: number;
  /** What the hiss should be playing at, 0..1. */
  staticGain: number;
  /** True while the change is still audible. */
  settling: boolean;
}

export const OFF = 0;

/**
 * Where a change has got to, `elapsedMs` after the switch was turned.
 * `onStation` is false at position 0, where the static fades into silence
 * instead of into a channel.
 */
export function readTuning(
  elapsedMs: number,
  onStation: boolean,
  config: TuneConfig = DEFAULT_TUNE,
): TuneState {
  const t = Math.max(0, elapsedMs);

  if (t >= config.staticMs + config.fadeMs) {
    return { stationGain: onStation ? 1 : 0, staticGain: 0, settling: false };
  }
  if (t < config.staticMs) {
    return { stationGain: 0, staticGain: 1, settling: true };
  }

  // Equal power, so the hiss and the channel don't dip against each other.
  const x = (t - config.staticMs) / config.fadeMs;
  return {
    stationGain: onStation ? Math.sin(x * (Math.PI / 2)) : 0,
    staticGain: Math.cos(x * (Math.PI / 2)),
    settling: true,
  };
}

/** Next position on the switch, wrapping through off. */
export function nextPosition(position: number, channels: number): number {
  return channels < 1 ? OFF : (position + 1) % (channels + 1);
}
