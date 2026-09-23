/**
 * The mark on a photograph.
 * =========================
 *
 * A saved picture carries a small paper label in its corner — the island, the date, the
 * sky — the way a print from a seaside photo booth does. It is drawn onto the captured frame
 * (which never includes the interface), so it travels with the file wherever it is shared.
 *
 * Anything that goes wrong here costs the label, never the photograph: the caller gets the
 * frame back as it came.
 */

import { UI_COLORS } from '@nagisa/shared';

/** Lay `text` on the bottom-right corner of the image in `photo`. */
export async function markPhoto(photo: Blob, text: string): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(photo);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return photo;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // Sized to the picture, not the screen: a phone's photo and a desktop's read alike.
    const size = Math.max(12, Math.round(canvas.height * 0.024));
    const pad = Math.round(size * 0.6);
    const margin = Math.round(size * 1.1);
    ctx.font = `${size}px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", "Songti SC", serif`;
    const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    const height = size + pad * 2;
    const x = canvas.width - margin - width;
    const y = canvas.height - margin - height;

    ctx.fillStyle = UI_COLORS.surfaceRaised;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(x, y, width, height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = UI_COLORS.ink;
    ctx.lineWidth = Math.max(1, size / 14);
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    ctx.fillStyle = UI_COLORS.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + pad, y + height / 2 + size * 0.05);

    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? photo), 'image/png'));
  } catch {
    return photo;
  }
}
