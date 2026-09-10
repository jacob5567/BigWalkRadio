// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getKV, setKV } from '../src/core/db';
import { InfoPanel } from '../src/app/info';
import { resetStorage } from './browser-stubs';

function press(key: string, options: KeyboardEventInit = {}): void {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
}

describe('the info sheet', () => {
  let info: InfoPanel;

  beforeEach(async () => {
    await resetStorage();
    document.body.innerHTML = '';
    info = new InfoPanel();
    info.mount(document.body);
  });

  afterEach(() => {
    info.dispose();
  });

  it('starts closed, with a button in the corner to open it', () => {
    expect(info.isOpen).toBe(false);
    expect(document.body.contains(info.button)).toBe(true);

    info.button.click();
    expect(info.isOpen).toBe(true);
    expect(info.button.getAttribute('aria-expanded')).toBe('true');
  });

  it('greets a first visit', async () => {
    await info.greet();
    expect(info.isOpen).toBe(true);
  });

  it('leaves a listener who has read it alone', async () => {
    await setKV('info-seen', true);
    await info.greet();
    expect(info.isOpen).toBe(false);
  });

  it('remembers being closed, so it only greets once', async () => {
    await info.greet();
    info.dismiss();
    expect(info.isOpen).toBe(false);
    expect(await getKV<boolean>('info-seen')).toBe(true);

    const second = new InfoPanel();
    second.mount(document.body);
    await second.greet();
    expect(second.isOpen).toBe(false);
    second.dispose();
  });

  it('closes on escape', () => {
    info.open();
    press('Escape');
    expect(info.isOpen).toBe(false);
  });

  it('closes when the dark either side of it is pressed, but not the sheet', () => {
    info.open();
    const backdrop = document.querySelector<HTMLElement>('.info-backdrop')!;
    backdrop.querySelector<HTMLElement>('.info-sheet')!.click();
    expect(info.isOpen).toBe(true);

    backdrop.click();
    expect(info.isOpen).toBe(false);
  });

  it('hands focus to the sheet and gives it back on the way out', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    info.open();
    expect(document.activeElement).toBe(document.querySelector('.info-sheet'));

    info.dismiss();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('wraps the tab order rather than letting it out', () => {
    info.open();
    const stops = [...document.querySelectorAll<HTMLElement>('.info-sheet a[href], .info-sheet button')];
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;

    last.focus();
    press('Tab');
    expect(document.activeElement).toBe(first);

    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('says what the switches do, both clocks, and who wrote the music', () => {
    info.open();
    const text = document.querySelector('.info-sheet')!.textContent ?? '';

    for (const control of ['Switch', 'Speaker', 'Wheel', 'Media keys']) {
      expect(text).toContain(control);
    }
    expect(text).toContain('Back a channel, forward a channel');
    expect(text).toContain('REAL');
    expect(text).toContain('GAME');
    expect(text).toContain('Install app');
    expect(text).toContain('aksfx');
    expect(text).toContain('House House');

    // Android and Firefox before Safari, which is the order asked for.
    const steps = [...document.querySelectorAll('.info-steps li')].map((li) => li.textContent ?? '');
    expect(steps.map((s) => s.split(':')[0])).toEqual(['Android, Chrome', 'Android, Firefox', 'iPhone or iPad']);
    expect(steps[2]).toContain('Add to Home Screen');

    const links = [...document.querySelectorAll<HTMLAnchorElement>('.info-sheet a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.href).toContain('aksfx.bandcamp.com');
  });
});
