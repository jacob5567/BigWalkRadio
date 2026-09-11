/**
 * iOS decides what an app's audio *is* before it decides whether to keep
 * playing it. Left alone, WebKit categorises a page's audio as 'auto', which
 * behaves like ambient sound: the ring/silent switch mutes it, and the system
 * feels free to interrupt it the moment the app goes to the background.
 *
 * 'playback' is the category for an app whose whole point is playing audio.
 * It is what lets a radio keep going once the home button is pressed.
 *
 * WebKit-only (Safari 16.4 and up); everywhere else this is a no-op.
 * See https://webkit.org/blog/14105/webkit-features-in-safari-16-4/
 */
export type AudioSessionType =
  | 'auto'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'ambient'
  | 'play-and-record';

interface AudioSession {
  type: AudioSessionType;
}

type MaybeSessioned = Navigator & { audioSession?: AudioSession };

/** True where the browser exposes the session at all, which is iOS and Safari. */
export function hasAudioSession(): boolean {
  return typeof navigator !== 'undefined' && 'audioSession' in (navigator as MaybeSessioned);
}

/**
 * Declares this a playback app. Safe to call more than once, and safe to call
 * where the API doesn't exist.
 */
export function claimPlaybackSession(): boolean {
  const session = (navigator as MaybeSessioned | undefined)?.audioSession;
  if (!session) return false;
  try {
    session.type = 'playback';
    return true;
  } catch {
    // Some builds expose it read-only. Nothing to do but carry on without it.
    return false;
  }
}
