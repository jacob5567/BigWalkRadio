import { assetUrl } from './paths';
import { SOUND_EFFECTS } from './sfx';

/** Something the radio does that has a sound attached to it. */
export type SfxAction = 'on' | 'off' | 'channelChange';

export interface SoundBankOptions {
  /** Injectable for tests; the takes are chosen at random otherwise. */
  random?: () => number;
  sources?: Record<string, string[]>;
}

/**
 * The switch clicks and channel-change noises, decoded once and played as
 * one-shots. Each action has several takes and picks between them, so working
 * the radio doesn't sound like the same recording over and over.
 */
export class SoundBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly lastPlayed = new Map<SfxAction, string>();
  private readonly failed = new Set<string>();
  private readonly sources: Record<string, string[]>;
  private readonly random: () => number;
  private readonly encoded = new Map<string, ArrayBuffer>();
  private ctx: AudioContext | null = null;
  private destination: AudioNode | null = null;
  private loading: Promise<void> | null = null;
  private prefetching: Promise<void> | null = null;

  constructor(options: SoundBankOptions = {}) {
    this.sources = options.sources ?? SOUND_EFFECTS;
    this.random = options.random ?? Math.random;
  }

  /** Files the host isn't serving, so the radio works those actions silently. */
  get missing(): ReadonlySet<string> {
    return this.failed;
  }

  get ready(): boolean {
    return this.buffers.size > 0;
  }

  private urlFor(path: string): string {
    return assetUrl(path);
  }

  /**
   * Fetches every take. Needs no audio context, so it can run on page load
   * rather than waiting for the first press to go and get them.
   */
  prefetch(): Promise<void> {
    this.prefetching ??= Promise.all(
      Object.values(this.sources).flat().map(async (path) => {
        try {
          const response = await fetch(this.urlFor(path));
          if (!response.ok) throw new Error(String(response.status));
          this.encoded.set(path, await response.arrayBuffer());
        } catch {
          this.failed.add(path);
        }
      }),
    ).then(() => undefined);
    return this.prefetching;
  }

  /** Decodes what was fetched. Runs once, however often it is called. */
  load(ctx: AudioContext, destination: AudioNode): Promise<void> {
    this.ctx = ctx;
    this.destination = destination;
    this.loading ??= this.decodeAll(ctx);
    return this.loading;
  }

  private async decodeAll(ctx: AudioContext): Promise<void> {
    await this.prefetch();
    await Promise.all([...this.encoded].map(async ([path, data]) => {
      try {
        this.buffers.set(path, toStereo(ctx, await ctx.decodeAudioData(data)));
      } catch {
        this.failed.add(path);
      }
    }));
    // decodeAudioData takes the buffers with it, so there is nothing to keep.
    this.encoded.clear();
  }

  /** A take for this action, never the same one twice running. */
  pick(action: SfxAction): string | null {
    const takes = (this.sources[action] ?? []).filter((path) => this.buffers.has(path));
    if (takes.length === 0) return null;
    if (takes.length === 1) return takes[0]!;

    const last = this.lastPlayed.get(action);
    const choices = takes.filter((path) => path !== last);
    const chosen = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))]!;
    this.lastPlayed.set(action, chosen);
    return chosen;
  }

  /** Plays a take at once. Returns how long it runs for, or 0 if there is none. */
  play(action: SfxAction): number {
    if (!this.ctx || !this.destination) return 0;
    const path = this.pick(action);
    if (!path) return 0;
    const buffer = this.buffers.get(path);
    if (!buffer) return 0;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    source.start();
    return buffer.duration;
  }
}

/**
 * These files are mono with no declared channel layout, which players that
 * don't upmix drop into the left speaker alone. Spreading them across both
 * here means it can't depend on anyone's defaults.
 */
export function toStereo(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels !== 1) return buffer;

  const stereo = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
  const mono = buffer.getChannelData(0);
  stereo.getChannelData(0).set(mono);
  stereo.getChannelData(1).set(mono);
  return stereo;
}
