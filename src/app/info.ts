import { getKV, setKV } from '../core/db';
import { el } from './dom';

/** Set once the panel has been closed, so it greets a listener only the once. */
const KEY_SEEN = 'info-seen';

const SOUNDTRACK = 'https://aksfx.bandcamp.com/';

/** The face and the tray, in the order a hand finds them. */
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['Switch', 'On and off. The aerial goes up with it.'],
  ['Speaker', 'A button. Press it to move on a channel, round through off.'],
  ['‹  ›', 'Back a channel, forward a channel.'],
  ['Wheel', 'Volume. Drag it, scroll it, or use the arrow keys.'],
  ['REAL · GAME', 'Which clock the schedule runs on.'],
  ['Media keys', 'Play and pause work the switch; the track buttons change channel.'],
];

/** Anything inside the sheet that can take focus, for the tab loop. */
const FOCUSABLE = 'a[href], button';

function section(heading: string, ...body: Array<Node | string>): HTMLElement {
  return el('section', { class: 'info-section' }, el('h2', { text: heading }), ...body);
}

function control([name, what]: readonly [string, string]): HTMLElement[] {
  return [el('dt', { text: name }), el('dd', { text: what })];
}

/**
 * The welcome sheet: what the knobs do, what the two clocks mean, how to keep
 * the thing on a home screen, and who wrote the music. Shown unasked on a first
 * visit, and after that only when the corner button is pressed.
 */
export class InfoPanel {
  /** The small button in the corner, which is also what closing returns to. */
  readonly button = el(
    'button',
    { class: 'info-button', type: 'button', 'aria-label': 'About this radio', 'aria-expanded': 'false' },
    el('span', { class: 'info-glyph', text: 'i' }),
  );

  private readonly close = el(
    'button',
    { class: 'info-close', type: 'button', 'aria-label': 'Close' },
    '×',
  );

  private readonly done = el('button', { class: 'info-done', type: 'button' }, 'Start listening');

  private readonly sheet: HTMLElement;
  private readonly backdrop: HTMLElement;
  private returnFocusTo: HTMLElement | null = null;

  constructor() {
    this.sheet = el('div', {
      class: 'info-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'info-title',
      tabindex: '-1',
    },
      this.close,
      el('h1', { class: 'info-title', id: 'info-title', text: 'Big Walk Radio' }),
      el('p', { class: 'info-lede' },
        'Seven channels of the ', el('em', { text: 'Big Walk' }), ' soundtrack, on a clock. Each station'
        + ' plays the track that belongs to the time of day, looped, until the next fades in over it.'),

      section('The controls',
        el('dl', { class: 'info-keys' }, ...CONTROLS.flatMap(control))),

      section('REAL and GAME',
        el('p', {},
          el('b', { text: 'REAL' }),
          ' runs on your own clock: a 7:12am track goes on at 7:12am, so a channel can sit on one piece'
          + ' for hours.'),
        el('p', {},
          el('b', { text: 'GAME' }),
          ' folds a whole broadcast day into 24 real minutes, as it runs in the game. The music still'
          + ' plays at its own speed; only the schedule hurries.')),

      section('Keeping it on a phone',
        el('p', { text: 'On the home screen it opens full screen, with its own icon.' }),
        el('ul', { class: 'info-steps' },
          el('li', {}, el('b', { text: 'Android, Chrome: ' }),
            'the ⋮ menu, then ', el('b', { text: 'Install app' }), '.'),
          el('li', {}, el('b', { text: 'Android, Firefox: ' }),
            'the ⋮ menu, then ', el('b', { text: 'Add to Home screen' }), '.'),
          el('li', {}, el('b', { text: 'iPhone or iPad: ' }),
            'in Safari, Share, then ', el('b', { text: 'Add to Home Screen' }), '.'))),

      section('Credits',
        el('p', {},
          'Music and sound by ',
          el('a', { class: 'info-link', href: SOUNDTRACK, target: '_blank', rel: 'noreferrer', text: 'aksfx' }),
          ', for ', el('em', { text: 'Big Walk' }), ' by ', el('b', { text: 'House House' }), '.'),
        el('p', { class: 'info-fine' },
          'A fan-made player, not affiliated with either. Soundtrack: ',
          el('a', { class: 'info-link', href: SOUNDTRACK, target: '_blank', rel: 'noreferrer', text: 'aksfx.bandcamp.com' }),
          '.')),

      this.done,
    );

    this.backdrop = el('div', { class: 'info-backdrop', hidden: true }, this.sheet);
  }

  mount(host: HTMLElement): void {
    this.button.onclick = () => this.open();
    this.close.onclick = () => this.dismiss();
    this.done.onclick = () => this.dismiss();
    // A press on the dark either side of the sheet is a press to be let out.
    this.backdrop.onclick = (event) => {
      if (event.target === this.backdrop) this.dismiss();
    };
    host.append(this.button, this.backdrop);
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.backdrop.remove();
    this.button.remove();
  }

  get isOpen(): boolean {
    return !this.backdrop.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.backdrop.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    document.body.classList.add('info-open');
    document.addEventListener('keydown', this.onKeyDown, true);
    this.sheet.scrollTop = 0;
    this.sheet.focus();
  }

  /** Closing it is also what marks it read, whichever way it was closed. */
  dismiss(): void {
    if (!this.isOpen) return;
    this.backdrop.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('info-open');
    document.removeEventListener('keydown', this.onKeyDown, true);
    (this.returnFocusTo ?? this.button).focus();
    this.returnFocusTo = null;
    // Nothing depends on this landing, and a browser with no storage still works.
    void setKV(KEY_SEEN, true).catch(() => {});
  }

  /** Opens on a first visit. A listener who has read it gets the radio instead. */
  async greet(): Promise<void> {
    const seen = await getKV<boolean>(KEY_SEEN).catch(() => false);
    if (!seen) this.open();
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    // Nothing behind the sheet is reachable while it is up, so the tab order
    // wraps within it rather than wandering off into the radio.
    const stops = [...this.sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === this.sheet)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
