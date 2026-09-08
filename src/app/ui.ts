import type { Radio, RadioState } from '../core/radio';
import { clear, el } from './dom';
import { Wheel } from './wheel';

/**
 * The unit is drawn at the size it was designed at and scaled down to fit
 * whatever screen it lands on, so every offset below stays exact.
 */
const UNIT_WIDTH = 460;

/** Where each dial stem hangs from, so the row of them reads as a skyline. */
const STEM_TOP = [32, 6, 46, 62, 31, 18, 44];

/** The stems and the marker share one origin, 18px in and offset by width. */
function slotLeft(fraction: number, nudge: number): string {
  return `calc(18px + ${(fraction * 100).toFixed(2)}% - ${(fraction * 17.2 + nudge).toFixed(2)}px)`;
}

/** The speaker grille: one hole at the centre, then rings out to the rim. */
function grille(): HTMLElement[] {
  const holes = [el('span', { class: 'hole' })];
  holes[0]!.style.left = '50%';
  holes[0]!.style.top = '50%';
  for (let radius = 26; radius <= 150; radius += 31) {
    const count = Math.max(6, Math.round((2 * Math.PI * radius) / 22));
    for (let i = 0; i < count; i++) {
      // Each ring is turned a little further round than the last, so the holes
      // don't line up into spokes.
      const angle = (i / count) * Math.PI * 2 + (radius / 31) * 0.3;
      const hole = el('span', { class: 'hole' });
      hole.style.left = `${(50 + (Math.cos(angle) * radius * 100) / 362).toFixed(2)}%`;
      hole.style.top = `${(50 + (Math.sin(angle) * radius * 100) / 362).toFixed(2)}%`;
      holes.push(hole);
    }
  }
  return holes;
}

/** The X of struts behind the speaker, and the bolts at their four tips. */
function speakerFrame(): HTMLElement[] {
  const parts = [45, 135, 225, 315].map((deg) => {
    const strut = el('div', { class: 'strut' });
    strut.style.transform = `rotate(${deg}deg)`;
    return strut;
  });
  for (const top of ['calc(50% - 195px)', 'calc(50% + 176px)']) {
    for (const left of ['calc(50% - 195px)', 'calc(50% + 176px)']) {
      const bolt = el('div', { class: 'bolt' }, el('div', { class: 'bolt-pin' }));
      bolt.style.left = left;
      bolt.style.top = top;
      parts.push(bolt);
    }
  }
  return parts;
}

/**
 * The radio itself: a lamp and a power switch, a display showing which of the
 * channels is tuned, and a tray of controls under the speaker.
 */
export class RadioUI {
  private readonly fit = el('div', { class: 'fit' });
  private readonly unit = el('div', { class: 'unit' });

  private readonly mast = el('div', { class: 'antenna-mast' });
  private readonly tip = el('div', { class: 'antenna-tip' });
  private readonly lampGlow = el('div', { class: 'lamp-glow' });

  private readonly power = el(
    'button',
    { class: 'power', type: 'button', role: 'switch', 'aria-label': 'Power' },
    el('span', { class: 'power-thumb' }, el('span', { class: 'power-dot' })),
  );

  private readonly film = el('div', { class: 'screen-static' });
  private readonly ticks = el('div', { class: 'ticks' });
  private readonly dial = el('div', { class: 'dial' });
  private readonly marker = el('div', { class: 'marker' });

  private readonly volume = new Wheel({
    label: 'Volume',
    onInput: (value) => this.radio.setVolume(value),
  });
  private readonly volNumber = el('span', { class: 'vol-num' });
  private readonly volFill = el('div', { class: 'vol-fill' });

  private readonly rocker = el(
    'button',
    { class: 'rocker', type: 'button', role: 'switch', 'aria-label': 'Game time' },
    el('span', { class: 'rocker-half real' }, 'REAL'),
    el('span', { class: 'rocker-half game' }, 'GAME'),
  );

  /** The speaker doubles as the single button: press it to cycle on round. */
  private readonly speaker = el('button', { class: 'speaker-rim', type: 'button' });

  private readonly back = el('button', { class: 'step', type: 'button', 'aria-label': 'Previous channel' }, '‹');
  private readonly forward = el('button', { class: 'step', type: 'button', 'aria-label': 'Next channel' }, '›');

  /** Nothing on the face is written down, so the reading is spoken instead. */
  private readonly announcement = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  private readonly diagnostics = el('p', { class: 'diagnostics' });

  private unsubscribe: (() => void) | null = null;
  private said = '';

  constructor(private readonly radio: Radio, private readonly root: HTMLElement) {}

  mount(): void {
    const channels = this.radio.channelCount;

    this.power.onclick = () => void this.radio.setPower(!this.radio.snapshot().power);
    this.back.onclick = () => void this.radio.stepChannel(-1);
    this.forward.onclick = () => void this.radio.stepChannel(1);
    this.rocker.onclick = () => this.radio.setMode(this.radio.getSettings().mode === 'real' ? 'game' : 'real');
    this.speaker.onclick = () => void this.radio.advance();

    this.buildScreen(channels);
    this.speaker.append(el('div', { class: 'speaker-face' }, ...grille()));
    this.unit.append(this.mast, this.tip, el('div', { class: 'body' },
      el('div', { class: 'top' },
        el('div', { class: 'power-col' },
          el('div', { class: 'lamp' }, this.lampGlow),
          this.power,
        ),
        el('div', { class: 'screen' },
          this.film,
          el('div', { class: 'screen-head' },
            el('div', { class: 'note' }, '♪'),
            this.ticks,
          ),
          this.dial,
        ),
      ),
      el('div', { class: 'speaker' },
        ...speakerFrame(),
        this.speaker,
      ),
      el('div', { class: 'tray' },
        this.volume.el,
        el('div', { class: 'vol' },
          el('div', { class: 'vol-pill' }, 'VOL ', this.volNumber, '%'),
          el('div', { class: 'vol-bar' }, this.volFill),
        ),
        this.rocker,
        el('div', { class: 'seek' }, this.back, this.forward),
      ),
    ));

    this.fit.append(this.unit);
    clear(this.root);
    this.root.append(el('div', { class: 'stage' }, this.fit, this.diagnostics, this.announcement));

    this.unsubscribe = this.radio.subscribe((state) => this.update(state));
    window.addEventListener('resize', this.refit);
    this.refit();
    // The display's height moves a little when the real fonts arrive.
    void document.fonts?.ready.then(this.refit).catch(() => {});
  }

  dispose(): void {
    window.removeEventListener('resize', this.refit);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** One tick and one stem per channel, laid out from the channel count. */
  private buildScreen(channels: number): void {
    this.ticks.style.setProperty('--channels', String(channels));
    for (let i = 0; i < channels; i++) {
      this.ticks.append(el('div', { class: 'tick' },
        el('div', { class: 'tick-num', text: String(i + 1).padStart(2, '0') }),
        el('div', { class: 'tick-bar' }),
      ));
    }

    this.dial.append(
      el('div', { class: 'dial-bg' }),
      el('div', { class: 'rule rule-h1' }),
      el('div', { class: 'rule rule-h2' }),
      el('div', { class: 'rule rule-v1' }),
      el('div', { class: 'rule rule-v2' }),
    );
    for (let i = 0; i < channels; i++) {
      const stem = el('div', { class: 'stem' },
        el('div', { class: 'stem-head' }),
        el('div', { class: 'stem-stick' }),
      );
      stem.style.top = `${STEM_TOP[i % STEM_TOP.length] ?? 32}px`;
      stem.style.left = slotLeft((i + 0.5) / channels, 4.3);
      this.dial.append(stem);
    }
    // The masks come last but for the marker, so the axes stop short of the
    // stems rather than running through them.
    this.dial.append(el('div', { class: 'mask-h' }), el('div', { class: 'mask-v' }), this.marker);
  }

  private readonly refit = () => {
    const width = this.root.clientWidth || window.innerWidth || UNIT_WIDTH;
    const scale = Math.min(1, Math.max(0.2, (width - 24) / UNIT_WIDTH));
    this.fit.style.setProperty('--scale', scale.toFixed(4));
    // The wrapper keeps the flow height of the unit, which the scale shrank.
    const height = this.unit.offsetHeight;
    this.fit.style.height = height > 0 ? `${Math.ceil((height + 16) * scale)}px` : '';
  };

  private update(state: RadioState): void {
    const on = state.power;
    this.unit.classList.toggle('on', on);

    this.lampGlow.style.opacity = on ? '1' : '0';
    this.mast.style.transform = `scaleY(${on ? 1 : 0.3})`;
    this.tip.style.transform = `translateY(${on ? 0 : 39}px)`;
    this.power.setAttribute('aria-checked', String(on));

    // The display hisses over a change and settles to a faint shimmer once the
    // channel has come up behind the click.
    const hiss = on ? 1 - state.tune.stationGain : 0;
    this.film.style.opacity = on ? (0.05 + 0.22 * hiss).toFixed(3) : '0';
    this.marker.style.left = on ? slotLeft((state.position - 0.5) / state.channels, -0.2) : '2.9px';

    const percent = Math.round(state.settings.volume * 100);
    this.volNumber.textContent = String(percent);
    this.volFill.style.width = `${(state.settings.volume * 100).toFixed(1)}%`;
    // Don't move the wheel out from under the hand that's turning it.
    if (!this.volume.isTurning) this.volume.set(state.settings.volume);

    const game = state.settings.mode === 'game';
    this.rocker.classList.toggle('game', game);
    this.rocker.setAttribute('aria-checked', String(game));

    this.back.disabled = !on;
    this.forward.disabled = !on;
    this.speaker.setAttribute('aria-label', on
      ? `Channel ${state.position} of ${state.channels}, ${state.onAir?.station.name ?? ''}.`
        + ' Press for the next.'
      : `Radio off. Press for channel 1 of ${state.channels}.`);

    this.announce(state);

    // A file the host isn't serving is otherwise just silence, so say so.
    const failed = this.radio.engine.failedTrackIds.size + this.radio.engine.missingSounds.size;
    this.diagnostics.textContent = failed === 0
      ? ''
      : `${failed} file${failed === 1 ? '' : 's'} not served — check ./music and ./audio on the host.`;
  }

  private announce(state: RadioState): void {
    const playing = state.onAir?.playing ?? null;
    const line = !state.power
      ? 'Radio off'
      : state.tune.settling
        ? `Channel ${state.position}, tuning`
        : `Channel ${state.position}, ${state.onAir?.station.name ?? ''}${playing ? `, ${playing.track.name}` : ''}`;
    if (line === this.said) return;
    this.said = line;
    this.announcement.textContent = line;
  }
}
