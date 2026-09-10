/**
 * Where the browser looks for a file the host serves. Paths are kept relative
 * to the site root so the app still works when it is hosted under a
 * subdirectory, and encoded because the soundtrack's filenames are full of
 * spaces and brackets.
 */
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}${encodeURI(path)}`;
}

/**
 * The same path as an absolute URL. The cache is keyed on what the media
 * element actually requests, which is absolute, so anything put there has to
 * be resolved the same way.
 */
export function absoluteAssetUrl(path: string): string {
  return new URL(assetUrl(path), location.href).href;
}
