// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wheel } from '../src/app/wheel';
import { installBrowserStubs } from './browser-stubs';

/** A 100x100 wheel centred at (50,50), so pointer angles are easy to aim. */
function place(wheel: Wheel): void {
  wheel.el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  document.body.append(wheel.el);
}

/** jsdom has no PointerEvent, but the wheel only reads mouse-event fields. */
function pointer(el: HTMLElement, type: string, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

describe('Wheel', () => {
  let changes: number[];
  let wheel: Wheel;

  beforeEach(() => {
    installBrowserStubs();
    changes = [];
    wheel = new Wheel({ label: 'Volume', onInput: (v) => changes.push(v) });
    place(wheel);
  });

  it('describes itself as a slider, since a knob has no role of its own', () => {
    wheel.set(0.5);
    expect(wheel.el.getAttribute('role')).toBe('slider');
    expect(wheel.el.getAttribute('aria-label')).toBe('Volume');
    expect(wheel.el.getAttribute('aria-valuenow')).toBe('50');
    expect(wheel.el.getAttribute('aria-valuetext')).toBe('50 percent');
  });

  it('turns the indicator with the value', () => {
    wheel.set(0);
    expect(wheel.el.querySelector<HTMLElement>('.wheel-indicator')!.style.transform).toBe('rotate(-135deg)');
    wheel.set(1);
    expect(wheel.el.querySelector<HTMLElement>('.wheel-indicator')!.style.transform).toBe('rotate(135deg)');
  });

  it('does not report a change when set from outside', () => {
    wheel.set(0.7);
    expect(changes).toEqual([]);
  });

  it('rises as it is turned clockwise', () => {
    wheel.set(0.5);
    pointer(wheel.el, 'pointerdown', 100, 50); // 0 degrees, due right
    pointer(wheel.el, 'pointermove', 50, 100); // +90 degrees, straight down
    // A quarter turn of the 270 degree sweep.
    expect(changes.at(-1)).toBeCloseTo(0.5 + 90 / 270, 6);
  });

  it('falls as it is turned back', () => {
    wheel.set(0.5);
    pointer(wheel.el, 'pointerdown', 100, 50);
    pointer(wheel.el, 'pointermove', 50, 0); // -90 degrees, straight up
    expect(changes.at(-1)).toBeCloseTo(0.5 - 90 / 270, 6);
  });

  it('takes the short way round when the notch passes the top', () => {
    wheel.set(0.5);
    pointer(wheel.el, 'pointerdown', 0, 49); // just above due left
    pointer(wheel.el, 'pointermove', 0, 51); // just below due left
    // Crossing 180 degrees must not read as a 358 degree lurch.
    expect(Math.abs(changes.at(-1)! - 0.5)).toBeLessThan(0.05);
  });

  it("ignores movement when it is not being turned", () => {
    wheel.set(0.5);
    pointer(wheel.el, 'pointermove', 50, 100);
    expect(changes).toEqual([]);
  });

  it('stops turning when the pointer is released', () => {
    wheel.set(0.5);
    pointer(wheel.el, 'pointerdown', 100, 50);
    expect(wheel.isTurning).toBe(true);
    pointer(wheel.el, 'pointerup', 100, 50);
    expect(wheel.isTurning).toBe(false);

    changes.length = 0;
    pointer(wheel.el, 'pointermove', 50, 100);
    expect(changes).toEqual([]);
  });

  it('answers the arrow keys', () => {
    wheel.set(0.5);
    wheel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
    expect(changes.at(-1)).toBeCloseTo(0.55, 6);
    wheel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    expect(changes.at(-1)).toBeCloseTo(0.5, 6);
    wheel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', cancelable: true }));
    expect(changes.at(-1)).toBe(0);
    wheel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', cancelable: true }));
    expect(changes.at(-1)).toBe(1);
  });

  it("leaves keys it does not handle alone", () => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    wheel.el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(changes).toEqual([]);
  });

  it('answers the scroll wheel', () => {
    wheel.set(0.5);
    wheel.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, cancelable: true }));
    expect(changes.at(-1)).toBeGreaterThan(0.5);
  });

  it('stops at silence and at full', () => {
    wheel.set(0);
    wheel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    expect(changes).toEqual([]); // already at 0, nothing to report
    expect(wheel.el.getAttribute('aria-valuenow')).toBe('0');

    wheel.set(1);
    wheel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
    expect(wheel.el.getAttribute('aria-valuenow')).toBe('100');
  });

  it('reports every step of a turn, not just the end of it', () => {
    wheel.set(0.5);
    pointer(wheel.el, 'pointerdown', 100, 50);
    pointer(wheel.el, 'pointermove', 85, 85);
    pointer(wheel.el, 'pointermove', 50, 100);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toBeLessThan(changes[1]!);
  });
});

describe('Wheel and the radio', () => {
  it('is a plain value source, so it can drive anything', () => {
    installBrowserStubs();
    const setVolume = vi.fn();
    const wheel = new Wheel({ label: 'Volume', onInput: setVolume });
    place(wheel);
    wheel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', cancelable: true }));
    expect(setVolume).toHaveBeenCalledWith(1);
  });
});
