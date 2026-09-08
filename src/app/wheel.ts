import { el } from './dom';

/** Degrees of rotation between silent and full. */
const SWEEP = 270;
const START_ANGLE = -135;
const KEY_STEP = 0.05;
const KEY_PAGE = 0.2;
const SCROLL_STEP = 0.04;
/** Ridges around the rim, so the turn is visible from any angle. */
const RIDGES = 16;
/** How far out from the centre they sit, in the knob's own pixels. */
const RIDGE_RADIUS = 27;

export interface WheelOptions {
  label: string;
  onInput: (value: number) => void;
}

function angleAt(element: HTMLElement, x: number, y: number): number {
  const box = element.getBoundingClientRect();
  return (Math.atan2(y - (box.top + box.height / 2), x - (box.left + box.width / 2)) * 180) / Math.PI;
}

/** Shortest way round, so crossing the top of the wheel doesn't jump. */
function angleDelta(to: number, from: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The ridged rim and the pointer, which turn together with the value. */
function face(): HTMLElement[] {
  const parts: HTMLElement[] = [];
  for (let i = 0; i < RIDGES; i++) {
    const ridge = el('div', { class: 'wheel-ridge' });
    ridge.style.transform = `rotate(${((i / RIDGES) * 360).toFixed(1)}deg) translateY(-${RIDGE_RADIUS}px)`;
    parts.push(ridge);
  }
  parts.push(el('div', { class: 'wheel-pointer' }));
  return parts;
}

/**
 * A volume wheel you turn rather than a slider you drag along. Rotating it
 * through 270 degrees runs from silence to full; it also takes the scroll
 * wheel and the arrow keys, and reports itself as a slider to assistive
 * technology, which has no notion of a knob.
 */
export class Wheel {
  readonly el: HTMLElement;
  private readonly indicator = el('div', { class: 'wheel-indicator' }, ...face());
  private value = 0;
  private lastAngle = 0;
  private turning = false;

  constructor(private readonly options: WheelOptions) {
    this.el = el('div', {
      class: 'wheel',
      role: 'slider',
      tabindex: '0',
      'aria-label': options.label,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    }, this.indicator);

    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('pointermove', this.onPointerMove);
    this.el.addEventListener('pointerup', this.onPointerUp);
    this.el.addEventListener('pointercancel', this.onPointerUp);
    this.el.addEventListener('keydown', this.onKeyDown);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });

    this.render();
  }

  /** True while the user is turning it, so updates don't fight the hand. */
  get isTurning(): boolean {
    return this.turning;
  }

  /** Set the position without reporting a change back. */
  set(value: number): void {
    this.value = clamp01(value);
    this.render();
  }

  private commit(value: number): void {
    const next = clamp01(value);
    if (next === this.value) return;
    this.value = next;
    this.render();
    this.options.onInput(next);
  }

  private render(): void {
    const percent = Math.round(this.value * 100);
    this.indicator.style.transform = `rotate(${START_ANGLE + this.value * SWEEP}deg)`;
    this.el.setAttribute('aria-valuenow', String(percent));
    this.el.setAttribute('aria-valuetext', `${percent} percent`);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.turning = true;
    this.lastAngle = angleAt(this.el, event.clientX, event.clientY);
    this.el.setPointerCapture(event.pointerId);
    this.el.classList.add('turning');
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.turning) return;
    const angle = angleAt(this.el, event.clientX, event.clientY);
    this.commit(this.value + angleDelta(angle, this.lastAngle) / SWEEP);
    this.lastAngle = angle;
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.turning) return;
    this.turning = false;
    this.el.classList.remove('turning');
    if (this.el.hasPointerCapture(event.pointerId)) this.el.releasePointerCapture(event.pointerId);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const step = {
      ArrowUp: KEY_STEP, ArrowRight: KEY_STEP,
      ArrowDown: -KEY_STEP, ArrowLeft: -KEY_STEP,
      PageUp: KEY_PAGE, PageDown: -KEY_PAGE,
    }[event.key];

    if (step !== undefined) this.commit(this.value + step);
    else if (event.key === 'Home') this.commit(0);
    else if (event.key === 'End') this.commit(1);
    else return;

    event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent) => {
    this.commit(this.value - Math.sign(event.deltaY) * SCROLL_STEP);
    event.preventDefault();
  };
}
