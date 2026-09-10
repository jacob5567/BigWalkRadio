import { OfflineStore, type OfflineStatus } from '../core/offline';
import { el, formatBytes } from './dom';

/**
 * The offline download, as it appears in the welcome sheet: what it costs,
 * a warning to install the app first, a button, and a bar while it runs.
 *
 * It owns the store rather than borrowing one, and the sheet only hides itself
 * rather than tearing down, so a download carries on while the listener closes
 * this and goes back to the radio.
 */
export class OfflineSection {
  readonly el: HTMLElement;

  private readonly store: OfflineStore;
  private readonly summary = el('p', { class: 'off-summary' });
  private readonly action = el('button', { class: 'off-action', type: 'button' });
  private readonly cancel = el('button', { class: 'off-cancel', type: 'button' }, 'Cancel');
  private readonly remove = el('button', { class: 'off-remove', type: 'button' }, 'Remove the download');
  private readonly fill = el('div', { class: 'off-fill' });
  private readonly bar: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly note = el('p', { class: 'off-note' });

  private status: OfflineStatus;

  constructor(store = new OfflineStore()) {
    this.store = store;
    this.status = {
      state: OfflineStore.supported ? 'absent' : 'unsupported',
      done: 0,
      total: store.totalBytes,
      files: 0,
      fileCount: store.fileCount,
    };

    this.bar = el('div', {
      class: 'off-bar',
      role: 'progressbar',
      'aria-label': 'Download progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    }, this.fill);

    this.progress = el('div', { class: 'off-progress', hidden: true },
      this.bar,
      el('div', { class: 'off-row' },
        el('p', { class: 'off-status', role: 'status', 'aria-live': 'polite' }),
        this.cancel),
    );

    this.action.onclick = () => void this.download();
    this.cancel.onclick = () => this.store.cancel();
    this.remove.onclick = () => void this.clear();

    this.el = el('section', { class: 'info-section' },
      el('h2', { text: 'Listening offline' }),
      el('p', {},
        'The music streams from the server as it plays. Keep a copy on the device and the radio works'
        + ' with no connection at all.'),
      el('p', { class: 'off-warn' },
        el('b', { text: 'Install it to the home screen first. ' }),
        'An installed app keeps its own storage, so a copy saved in the browser will not follow it'
        + ' across. Then start this on wi-fi — it is a ',
        el('b', {}, formatBytes(store.totalBytes)), ' download.'),
      this.summary,
      this.action,
      this.progress,
      this.remove,
      this.note,
    );

    this.render();
  }

  /** Reads back what is on the device. Called whenever the sheet is opened. */
  async refresh(): Promise<void> {
    if (this.store.isDownloading) return;
    this.status = await this.store.status();
    this.render();
  }

  /** Fetches the lot, repainting as it goes. Resolves once it settles. */
  async download(): Promise<void> {
    if (this.store.isDownloading) return;
    await this.store.download((status) => {
      this.status = status;
      this.render();
    });
  }

  /** Throws the stored copy away and goes back to streaming. */
  async clear(): Promise<void> {
    this.status = await this.store.remove();
    this.render();
  }

  private get statusLine(): HTMLElement {
    return this.progress.querySelector<HTMLElement>('.off-status')!;
  }

  private render(): void {
    const { state, done, total, files, fileCount } = this.status;
    const running = state === 'downloading';

    this.progress.hidden = !running;
    this.el.classList.toggle('is-stored', state === 'stored');

    if (running) {
      const fraction = total > 0 ? Math.min(1, done / total) : 0;
      this.fill.style.width = `${(fraction * 100).toFixed(1)}%`;
      this.bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
      this.statusLine.textContent =
        `${formatBytes(done)} of ${formatBytes(total)} · ${files} of ${fileCount} files`;
    }

    // The button is the one thing that changes shape between states, so it
    // carries the whole story: what pressing it will do next.
    this.action.hidden = running || state === 'stored' || state === 'unsupported';
    this.remove.hidden = state !== 'stored';

    switch (state) {
      case 'unsupported':
        this.summary.textContent = 'This browser will not store the music. Try it installed, or outside a private window.';
        break;
      case 'absent':
        this.summary.textContent = '';
        this.action.textContent = `Download ${formatBytes(total)}`;
        break;
      case 'partial':
        this.summary.textContent = `${formatBytes(done)} of ${formatBytes(total)} is already here.`;
        this.action.textContent = 'Resume the download';
        break;
      case 'downloading':
        this.summary.textContent = 'Downloading. You can close this and listen while it runs.';
        break;
      case 'stored':
        this.summary.textContent = `All ${fileCount} files are on this device — ${formatBytes(total)}. The radio plays offline.`;
        break;
      case 'error':
        this.summary.textContent = '';
        this.action.textContent = 'Try the download again';
        break;
    }

    this.note.textContent = state === 'error' ? `That didn't finish: ${this.status.message ?? 'unknown error'}` : '';
    this.note.hidden = state !== 'error';
  }
}
