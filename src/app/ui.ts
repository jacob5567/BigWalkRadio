import { formatDayHour } from '../core/clock';
import { formatTimeOfDay } from '../core/naming';
import type { Radio, RadioState } from '../core/radio';
import { clear, el, humanSpan, mmss } from './dom';

/**
 * One screen: the radio itself. The dial comes from whatever the host is
 * serving, so there is nothing to import and nothing to arrange.
 */
export class RadioUI {
  /** True while a slider is under the thumb, so ticks don't yank it away. */
  private dragging = false;

  private readonly out = {
    channel: el('div', { class: 'channel-number' }),
    station: el('div', { class: 'station-name' }),
    daypart: el('div', { class: 'daypart' }),
    track: el('div', { class: 'track' }),
    position: el('div', { class: 'position' }),
    handover: el('div', { class: 'handover' }),
    blend: el('div', { class: 'blend' }),
    clock: el('div', { class: 'clock' }),
    signal: el('div', { class: 'meter-fill' }),
    noise: el('div', { class: 'meter-fill noise' }),
    power: el('button', { class: 'power', type: 'button' }, 'Off'),
    dial: el('input', { class: 'dial', type: 'range', min: '1', max: '8', step: '0.02' }),
    volume: el('input', { class: 'volume', type: 'range', min: '0', max: '1', step: '0.01' }),
    diagnostics: el('div', { class: 'diagnostics' }),
  };

  private readonly modeReal = el('button', { class: 'mode', type: 'button' }, 'Real time');
  private readonly modeGame = el('button', { class: 'mode', type: 'button' }, 'Game time');
  private readonly dayMinutes = el('input', { class: 'num', type: 'number', min: '1', max: '1440', step: '1' });
  private readonly compress = el('input', { type: 'checkbox' });
  private readonly blendSeconds = el('input', { class: 'num', type: 'number', min: '0', max: '120', step: '1' });

  constructor(private readonly radio: Radio, private readonly root: HTMLElement) {}

  mount(): void {
    const o = this.out;

    o.power.onclick = () => void this.radio.setPower(!this.radio.getSettings().powered);
    o.dial.addEventListener('input', () => this.radio.setChannel(Number(o.dial.value)));
    o.volume.addEventListener('input', () => this.radio.setVolume(Number(o.volume.value)));
    for (const slider of [o.dial, o.volume]) {
      slider.addEventListener('pointerdown', () => { this.dragging = true; });
      slider.addEventListener('pointerup', () => { this.dragging = false; });
      slider.addEventListener('pointercancel', () => { this.dragging = false; });
    }

    this.modeReal.onclick = () => this.radio.setMode('real');
    this.modeGame.onclick = () => this.radio.setMode('game');
    this.dayMinutes.addEventListener('change', () => this.radio.setGameDayMinutes(Number(this.dayMinutes.value)));
    this.compress.addEventListener('change', () => this.radio.setCompressTrackTimeline(this.compress.checked));
    this.blendSeconds.addEventListener('change', () => this.radio.setBlendSeconds(Number(this.blendSeconds.value)));

    clear(this.root);
    this.root.append(el('section', { class: 'pane' },
      el('div', { class: 'readout' },
        o.channel,
        el('div', { class: 'readout-body' }, o.station, o.daypart, o.track, o.position, o.handover, o.blend),
      ),
      el('div', { class: 'meters' },
        el('label', {}, 'signal', el('div', { class: 'meter' }, o.signal)),
        el('label', {}, 'static', el('div', { class: 'meter' }, o.noise)),
      ),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'step', onclick: () => this.radio.seekStation(-1) }, '‹'),
        o.dial,
        el('button', { type: 'button', class: 'step', onclick: () => this.radio.seekStation(1) }, '›'),
      ),
      el('div', { class: 'row' }, o.power, el('label', { class: 'grow' }, 'volume', o.volume)),
      el('div', { class: 'row' }, this.modeReal, this.modeGame, o.clock),
      el('div', { class: 'row wrap' },
        el('label', {}, 'game day (real min)', this.dayMinutes),
        el('label', {}, 'blend (s)', this.blendSeconds),
        el('label', {}, this.compress, ' compress track timeline too'),
      ),
      o.diagnostics,
    ));

    this.radio.subscribe((state) => this.update(state));
  }

  private update(state: RadioState): void {
    const o = this.out;
    const tuned = state.tuned;

    o.channel.textContent = String(Math.round(state.settings.channel));
    o.channel.classList.toggle('off', !tuned);
    o.station.textContent = tuned ? tuned.station.name : 'no station';
    o.power.classList.toggle('on', state.settings.powered);
    o.power.textContent = state.settings.powered ? 'On' : 'Off';

    const playing = tuned?.playing ?? null;
    if (playing) {
      o.daypart.textContent = `${playing.instance.program.name} · from ${formatTimeOfDay(playing.instance.program.startHour * 60)}`;
      o.track.textContent = playing.track.name;
      o.position.textContent = `${mmss(playing.offsetSec)} / ${mmss(playing.track.duration)}${playing.loops ? ' · looping' : ''}`;
      o.handover.textContent = `next in ${humanSpan(playing.instance.endMs - state.reading.nowMs)}`;
    } else {
      o.daypart.textContent = tuned ? 'nothing scheduled' : '';
      o.track.textContent = '';
      o.position.textContent = '';
      o.handover.textContent = '';
    }

    const outgoing = tuned?.layers.find((l) => l.role === 'outgoing');
    o.blend.textContent = outgoing
      ? `blending from ${outgoing.track.name} — ${Math.round(outgoing.blend * 100)}%`
      : '';

    o.clock.textContent = state.reading.mode === 'real'
      ? formatDayHour(state.reading.dayHour)
      : `${formatDayHour(state.reading.dayHour)} · day ${state.reading.dayIndex} · ${state.reading.timelineRate.toFixed(0)}×`;

    o.signal.style.width = `${(tuned?.signal.gain ?? 0) * 100}%`;
    o.noise.style.width = `${state.dial.staticGain * 100}%`;

    if (!this.dragging) {
      o.dial.value = String(state.settings.channel);
      o.volume.value = String(state.settings.volume);
    }
    if (document.activeElement !== this.dayMinutes) this.dayMinutes.value = String(state.settings.gameDayMinutes);
    if (document.activeElement !== this.blendSeconds) this.blendSeconds.value = String(state.settings.blendSeconds);
    this.compress.checked = state.settings.compressTrackTimeline;
    this.modeReal.classList.toggle('active', state.settings.mode === 'real');
    this.modeGame.classList.toggle('active', state.settings.mode === 'game');

    // A file the host isn't serving is otherwise just silence, so say so.
    const failed = this.radio.engine.failedTrackIds;
    const missing = failed.size > 0
      ? ` · ${failed.size} file${failed.size === 1 ? '' : 's'} not served`
      : '';
    const audible = state.stations
      .flatMap((s) => s.layers.map((l) => ({ s, l })))
      .filter(({ s }) => s.signal.gain > 0.02)
      .map(({ s, l }) => `${s.station.channel}:${l.instance.program.name} ${Math.round(s.signal.gain * l.blend * 100)}%`);
    o.diagnostics.textContent = `audio ${this.radio.engine.contextState} · ${audible.length ? audible.join('  ') : 'silent'}${missing}`;
  }
}
