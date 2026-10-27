import freePost from './free-post.html?raw';
import notAPost from './not-a-post.html?raw';
import paywalledPost from './paywalled-post.html?raw';

export const fixtures = { freePost, paywalledPost, notAPost };

/** A 1x1 transparent PNG. */
export const TINY_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/** A minimal JPEG header (enough for media-type sniffing). */
export const TINY_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);
