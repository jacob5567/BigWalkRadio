import { formatDayHour } from '../core/clock';
import { storageEstimate } from '../core/db';
import { formatTimeOfDay } from '../core/naming';
import type { Radio, RadioState } from '../core/radio';
import { programWindow } from '../core/schedule';
import type { Track } from '../core/types';
import { clear, el, humanSpan, mmss } from './dom';

type Pane = 'radio' | 'schedule' | 'library';

export class RadioUI {
  private readonly panes = new Map<Pane, HTMLElement>();
  /** True while a slider is under the thumb, so ticks don't yank it away. */
  private dragging = false;

  // Live elements in the radio pane, updated on every tick.
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
    power: el('button', { class: 'power', type: 'button' }, 'Power'),
    dial: el('input', { class: 'dial', type: 'range', min: '1', max: '8', step: '0.02' }),
    volume: el('input', { class: 'volume', type: 'range', min: '0', max: '1', step: '0.01' }),
    diagnostics: el('div', { class: 'diagnostics' }),
  };

  private readonly modeReal = el('button', { class: 'mode', type: 'button' }, 'Real time');
  private readonly modeGame = el('button', { class: 'mode', type: 'button' }, 'Game time');
  private readonly dayMinutes = el('input', { class: 'num', type: 'number', min: '1', max: '1440', step: '1' });
  private readonly compress = el('input', { type: 'checkbox' });
  private readonly blendSeconds = el('input', { class: 'num', type: 'number', min: '0', max: '120', step: '1' });
  private readonly importNote = el('div', { class: 'note' });

  constructor(private readonly radio: Radio, private readonly root: HTMLElement) {}

  mount(): void {
    const tabs = el('nav', { class: 'tabs' },
      ...(['radio', 'schedule', 'library'] as Pane[]).map((name) =>
        el('button', {
          type: 'button',
          class: 'tab',
          'data-pane': name,
          onclick: () => this.show(name),
        }, name),
      ),
    );

    this.panes.set('radio', this.buildRadioPane());
    this.panes.set('schedule', el('section', { class: 'pane' }));
    this.panes.set('library', this.buildLibraryPane());

    clear(this.root);
    this.root.append(tabs, ...this.panes.values());
    this.show('radio');

    this.radio.subscribe((state) => this.update(state));
  }

  private show(pane: Pane): void {
    for (const [name, node] of this.panes) node.hidden = name !== pane;
    for (const tab of this.root.querySelectorAll<HTMLElement>('.tab')) {
      tab.classList.toggle('active', tab.dataset.pane === pane);
    }
    if (pane === 'schedule') this.renderSchedule();
    if (pane === 'library') this.renderLibrary();
  }

  // --- radio ----------------------------------------------------------------

  private buildRadioPane(): HTMLElement {
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

    return el('section', { class: 'pane' },
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
    );
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
      o.track.textContent = tuned ? 'assign audio in Schedule' : '';
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

    const voices = state.stations
      .flatMap((s) => s.layers.map((l) => ({ s, l })))
      .filter(({ s }) => s.signal.gain > 0.02)
      .map(({ s, l }) => `${s.station.channel}:${l.instance.program.name} ${Math.round(s.signal.gain * l.blend * 100)}%`);
    o.diagnostics.textContent = `audio ${this.radio.engine.contextState} · ${voices.length ? voices.join('  ') : 'silent'}`;
  }

  // --- schedule -------------------------------------------------------------

  private renderSchedule(): void {
    const pane = this.panes.get('schedule')!;
    const state = this.radio.snapshot();
    const tracks = this.radio.library.list();
    clear(pane);

    pane.append(el('p', { class: 'note' },
      'Each daypart is one track on repeat, from its start time until the next takes over.'));

    for (const station of this.radio.getStations()) {
      const rows = station.programs.map((program, index) => {
        const assigned = program.trackIds[0] ?? '';
        const track = assigned ? this.radio.library.get(assigned) : undefined;
        const windowMs = programWindow(station, index) * state.reading.dayLengthMs;

        const picker = el('select', {
          onchange: (event: Event) => {
            const id = (event.target as HTMLSelectElement).value;
            this.radio.mutateStation(station.id, (s) => ({
              ...s,
              programs: s.programs.map((p) => (p.id === program.id ? { ...p, trackIds: id ? [id] : [] } : p)),
            }));
            this.renderSchedule();
          },
        }, el('option', { value: '' }, '— empty —'),
          ...tracks.map((t) => el('option', { value: t.id, selected: t.id === assigned }, t.name)));

        return el('div', { class: 'program' },
          el('div', { class: 'time' }, formatTimeOfDay(program.startHour * 60)),
          el('div', { class: 'grow' },
            el('div', { class: 'program-name' }, program.name),
            el('div', { class: 'note' },
              `${humanSpan(windowMs)} on air` +
              (track ? ` · ${mmss(track.duration)} · ×${(windowMs / 1000 / track.duration).toFixed(1)} loops` : ' · no audio')),
            picker,
          ),
        );
      });

      pane.append(el('div', { class: 'station' },
        el('h2', {}, el('span', { class: 'chip' }, String(station.channel)), station.name),
        ...rows,
      ));
    }
  }

  // --- library --------------------------------------------------------------

  private buildLibraryPane(): HTMLElement {
    const files = el('input', { type: 'file', accept: 'audio/*', multiple: true });
    files.addEventListener('change', () => void this.handleFiles(files));

    const folder = el('input', { type: 'file', accept: 'audio/*', multiple: true });
    folder.setAttribute('webkitdirectory', '');
    folder.addEventListener('change', () => void this.handleFiles(folder));

    return el('section', { class: 'pane' },
      el('p', { class: 'note' },
        'Import your own audio. Files named like the soundtrack (“…-7-12am- Leitmotif”) ' +
        'are filed into their station and time automatically; anything else you place by hand in Schedule.'),
      el('label', { class: 'file' }, 'Add files', files),
      el('label', { class: 'file' }, 'Add a folder (desktop)', folder),
      this.importNote,
      el('div', { class: 'track-list' }),
    );
  }

  private async handleFiles(input: HTMLInputElement): Promise<void> {
    const chosen = [...(input.files ?? [])];
    if (chosen.length === 0) return;
    this.importNote.textContent = `Reading ${chosen.length} file${chosen.length === 1 ? '' : 's'}…`;
    const summary = await this.radio.importFiles(chosen);
    input.value = '';

    const parts = [`${summary.placed.length} filed into the schedule`];
    if (summary.unplaced.length) parts.push(`${summary.unplaced.length} need placing by hand`);
    if (summary.failed.length) parts.push(`${summary.failed.length} could not be read`);
    this.importNote.textContent = parts.join(' · ');
    this.renderLibrary();
  }

  private renderLibrary(): void {
    const pane = this.panes.get('library')!;
    const list = pane.querySelector('.track-list');
    if (!list) return;
    clear(list);

    const tracks = this.radio.library.list();
    if (tracks.length === 0) {
      list.append(el('p', { class: 'note' }, 'Nothing imported yet.'));
    }
    for (const track of tracks) {
      list.append(el('div', { class: 'track-row' },
        el('div', { class: 'grow' },
          el('div', {}, track.name),
          el('div', { class: 'note' }, this.describe(track)),
        ),
        el('button', {
          type: 'button',
          onclick: () => void this.radio.removeTrack(track.id).then(() => this.renderLibrary()),
        }, 'Remove'),
      ));
    }

    void storageEstimate().then((estimate) => {
      if (!estimate || estimate.quota === 0) return;
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
      list.append(el('p', { class: 'note' }, `Using ${mb(estimate.usage)} of ${mb(estimate.quota)} available.`));
    });
  }

  private describe(track: Track): string {
    const bits = [mmss(track.duration)];
    if (track.album) bits.push(track.album);
    if (track.timeOfDayMinutes != null) bits.push(formatTimeOfDay(track.timeOfDayMinutes));
    return bits.join(' · ');
  }
}
