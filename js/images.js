// Image handling: shrink on the device before storing, and resolve
// `img:<id>` references in card markdown to displayable blob URLs.

import { putImage, getImage } from './store.js';
import { fetchRemoteImage } from './sync.js';
import { newId } from './lib/util.js';

// Longest edge after resizing. Phone photos are 4000+ px and several MB;
// 1600 px stays sharp on a Retina MacBook and lands around 150–400 KB.
const MAX_EDGE = 1600;
const QUALITY = 0.8;

export async function importImage(file) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // White under transparent PNGs, since JPEG (the Safari fallback) has no alpha.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // Safari can't encode WebP and silently returns PNG instead, which would
  // be several times larger; fall back to JPEG there.
  let blob = await toBlob(canvas, 'image/webp', QUALITY);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new Error('This browser could not encode the image.');
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const id = `${newId()}.${ext}`;
  await putImage(id, blob, false);
  return id;
}

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try {
      // imageOrientation honours EXIF rotation from phone cameras.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall through to <img>, e.g. for HEIC on some browsers */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('This image format is not supported. Try a JPEG or PNG.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

const urlCache = new Map();

export async function imageUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  let blob = (await getImage(id))?.blob;
  if (!blob) blob = await fetchRemoteImage(id).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}
