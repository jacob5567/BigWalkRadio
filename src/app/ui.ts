import { formatDayHour } from '../core/clock';
import { formatTimeOfDay } from '../core/naming';
import type { Radio, RadioState } from '../core/radio';
import { OFF } from '../core/tuning';
import { clear, el, humanSpan, mmss } from './dom';
import { Wheel } from './wheel';

/**
 * One screen, one control: a switch that clicks from off through each channel
 * and back to off. Everything else on the page is a readout.
 */
export class RadioUI {
  private readonly out = {
    position: el('div', { class: 'position-number' }),
    positionLabel: el('div', { class: 'position-label' }),
    station: el('div', { class: 'station-name' }),
    daypart: el('div', { class: 'daypart' }),
    track: el('div', { class: 'track' }),
    elapsed: el('div', { class: 'elapsed' }),
    handover: el('div', { class: 'handover' }),
    blend: el('div', { class: 'blend' }),
    clock: el('div', { class: 'clock' }),
    diagnostics: el('div', { class: 'diagnostics' }),
  };

  private readonly volume = new Wheel({
    label: 'Volume',
    onInput: (value) => this.radio.setVolume(value),
  });

  private readonly power = el('button', { class: 'power', type: 'button', role: 'switch' },
    el('span', { class: 'power-track' }, el('span', { class: 'power-thumb' })),
    el('span', { class: 'power-label' }, 'power'),
  );

  private readonly back = el('button', { class: 'step', type: 'button', 'aria-label': 'Previous channel' }, '‹');
  private readonly forward = el('button', { class: 'step', type: 'button', 'aria-label': 'Next channel' }, '›');
  private readonly knob = el('button', { class: 'knob', type: 'button' });
  private readonly modeReal = el('button', { class: 'mode', type: 'button' }, 'Real time');
  private readonly modeGame = el('button', { class: 'mode', type: 'button' }, 'Game time');
  private readonly dayMinutes = el('input', { class: 'num', type: 'number', min: '1', max: '1440', step: '1' });
  private readonly compress = el('input', { type: 'checkbox' });
  private readonly blendSeconds = el('input', { class: 'num', type: 'number', min: '0', max: '120', step: '1' });
  private readonly seamMs = el('input', { class: 'num', type: 'number', min: '0', max: '5000', step: '10' });

  constructor(private readonly radio: Radio, private readonly root: HTMLElement) {}

  mount(): void {
    const o = this.out;

    this.knob.append(o.position, o.positionLabel);
    this.knob.onclick = () => void this.radio.advance();
    this.power.onclick = () => void this.radio.setPower(!this.radio.snapshot().power);
    this.back.onclick = () => void this.radio.stepChannel(-1);
    this.forward.onclick = () => void this.radio.stepChannel(1);

    this.modeReal.onclick = () => this.radio.setMode('real');
    this.modeGame.onclick = () => this.radio.setMode('game');
    this.dayMinutes.addEventListener('change', () => this.radio.setGameDayMinutes(Number(this.dayMinutes.value)));
    this.compress.addEventListener('change', () => this.radio.setCompressTrackTimeline(this.compress.checked));
    this.blendSeconds.addEventListener('change', () => this.radio.setBlendSeconds(Number(this.blendSeconds.value)));
    this.seamMs.addEventListener('change', () => this.radio.setSeamSeconds(Number(this.seamMs.value) / 1000));

    clear(this.root);
    this.root.append(el('section', { class: 'pane' },
      this.knob,
      el('div', { class: 'readout' }, o.station, o.daypart, o.track, o.elapsed, o.handover, o.blend),
      el('div', { class: 'controls' },
        this.volume.el,
        el('div', { class: 'stepper' }, this.back, this.forward),
        this.power,
      ),
      el('div', { class: 'row' }, this.modeReal, this.modeGame, o.clock),
      el('div', { class: 'row wrap' },
        el('label', {}, 'game day (real min)', this.dayMinutes),
        el('label', {}, 'blend (s)', this.blendSeconds),
        el('label', {}, 'loop seam (ms)', this.seamMs),
        el('label', {}, this.compress, ' compress track timeline too'),
      ),
      o.diagnostics,
    ));

    this.radio.subscribe((state) => this.update(state));
  }

  private update(state: RadioState): void {
    const o = this.out;
    const off = state.position === OFF;
    const playing = state.onAir?.playing ?? null;

    o.position.textContent = String(state.position);
    o.positionLabel.textContent = off ? 'off' : (state.onAir?.station.name ?? `channel ${state.position}`);
    this.knob.classList.toggle('off', off);
    this.knob.classList.toggle('tuning', state.tune.settling);
    this.knob.setAttribute(
      'aria-label',
      off
        ? `Radio off. Press for channel 1 of ${state.channels}.`
        : `Channel ${state.position} of ${state.channels}, ${state.onAir?.station.name ?? ''}. Press for the next.`,
    );

    o.station.textContent = off ? '' : (state.onAir?.station.name ?? '');

    if (state.tune.settling && !off) {
      // Mid-change the audio is still static, so don't claim a track yet.
      o.daypart.textContent = 'tuning…';
      o.track.textContent = '';
      o.elapsed.textContent = '';
      o.handover.textContent = '';
    } else if (playing) {
      const shuffles = playing.instance.program.order === 'shuffle';
      o.daypart.textContent = shuffles
        ? `${playing.instance.program.name} · shuffle`
        : `${playing.instance.program.name} · from ${formatTimeOfDay(playing.instance.program.startHour * 60)}`;
      o.track.textContent = playing.track.name;
      o.elapsed.textContent = `${mmss(playing.offsetSec)} / ${mmss(playing.track.duration)}${playing.loops ? ' · looping' : ''}`;
      o.handover.textContent = shuffles
        ? `next track in ${humanSpan(playing.trackEndsAtMs - state.reading.nowMs)}`
        : `next in ${humanSpan(playing.instance.endMs - state.reading.nowMs)}`;
    } else {
      o.daypart.textContent = off ? '' : 'nothing scheduled';
      o.track.textContent = '';
      o.elapsed.textContent = '';
      o.handover.textContent = '';
    }

    const outgoing = state.onAir?.layers.find((l) => l.role === 'outgoing');
    o.blend.textContent = outgoing && !state.tune.settling
      ? `blending from ${outgoing.track.name} — ${Math.round(outgoing.blend * 100)}%`
      : '';

    o.clock.textContent = state.reading.mode === 'real'
      ? formatDayHour(state.reading.dayHour)
      : `${formatDayHour(state.reading.dayHour)} · day ${state.reading.dayIndex} · ${state.reading.timelineRate.toFixed(0)}×`;

    this.power.setAttribute('aria-checked', String(state.power));
    this.power.classList.toggle('on', state.power);
    this.back.disabled = !state.power;
    this.forward.disabled = !state.power;
    // Don't move the wheel out from under the hand that's turning it.
    if (!this.volume.isTurning) this.volume.set(state.settings.volume);
    if (document.activeElement !== this.dayMinutes) this.dayMinutes.value = String(state.settings.gameDayMinutes);
    if (document.activeElement !== this.blendSeconds) this.blendSeconds.value = String(state.settings.blendSeconds);
    if (document.activeElement !== this.seamMs) this.seamMs.value = String(Math.round(state.settings.seamSeconds * 1000));
    this.compress.checked = state.settings.compressTrackTimeline;
    this.modeReal.classList.toggle('active', state.settings.mode === 'real');
    this.modeGame.classList.toggle('active', state.settings.mode === 'game');

    // A file the host isn't serving is otherwise just silence, so say so.
    const failed = this.radio.engine.failedTrackIds.size + this.radio.engine.missingSounds.size;
    const missing = failed > 0 ? ` · ${failed} file${failed === 1 ? '' : 's'} not served` : '';
    const level = state.tune.settling ? 'changing' : off ? 'silent' : `channel ${state.position}`;
    o.diagnostics.textContent = `audio ${this.radio.engine.contextState} · ${level}${missing}`;
  }
}
