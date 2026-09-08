/**
 * Lock screen, headphone and keyboard media controls, mapped onto the radio's
 * own switch: play and pause work the on/off switch, and the track buttons
 * step between channels.
 */
export interface MediaKeyActions {
  play(): void;
  pause(): void;
  previous(): void;
  next(): void;
}

const BINDINGS: ReadonlyArray<readonly [MediaSessionAction, keyof MediaKeyActions]> = [
  ['play', 'play'],
  ['pause', 'pause'],
  // A stop request is a request to be quiet, which for a radio is the off switch.
  ['stop', 'pause'],
  ['previoustrack', 'previous'],
  ['nexttrack', 'next'],
];

/** Registers the handlers and returns a function that takes them back off again. */
export function bindMediaKeys(actions: MediaKeyActions): () => void {
  if (!('mediaSession' in navigator)) return () => {};
  const session = navigator.mediaSession;
  const bound: MediaSessionAction[] = [];

  for (const [action, name] of BINDINGS) {
    try {
      session.setActionHandler(action, () => actions[name]());
      bound.push(action);
    } catch {
      // Not every platform offers every action, and asking for one it doesn't
      // know about throws. The rest are still worth having.
    }
  }

  return () => {
    for (const action of bound) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // It's going away regardless.
      }
    }
  };
}
