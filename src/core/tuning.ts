/**
 * The switch has an off position and one per channel. Every change is covered
 * by the radio's own click, and the new channel comes up under it, so nothing
 * ever cuts straight from one track to another.
 */
export interface TuneConfig {
  /** Milliseconds the new channel stays silent under the click. */
  holdMs: number;
  /** Milliseconds it then takes to come up. */
  fadeMs: number;
}

export const DEFAULT_TUNE: TuneConfig = { holdMs: 80, fadeMs: 200 };

export interface TuneState {
  /** What the selected channel should be playing at, 0..1. */
  stationGain: number;
  /** True while the change is still under way. */
  settling: boolean;
}

export const OFF = 0;

/**
 * Where a change has got to, `elapsedMs` after the switch was turned.
 * `onStation` is false at position 0, where nothing comes up behind the click.
 */
export function readTuning(
  elapsedMs: number,
  onStation: boolean,
  config: TuneConfig = DEFAULT_TUNE,
): TuneState {
  const t = Math.max(0, elapsedMs);

  if (t >= config.holdMs + config.fadeMs) {
    return { stationGain: onStation ? 1 : 0, settling: false };
  }
  if (t < config.holdMs) {
    return { stationGain: 0, settling: true };
  }

  const x = (t - config.holdMs) / config.fadeMs;
  return { stationGain: onStation ? Math.sin(x * (Math.PI / 2)) : 0, settling: true };
}

/** Next position on the switch, wrapping through off. */
export function nextPosition(position: number, channels: number): number {
  return channels < 1 ? OFF : (position + 1) % (channels + 1);
}
