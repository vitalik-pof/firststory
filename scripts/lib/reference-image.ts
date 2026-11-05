// Підготовка фото-референсу до завантаження: довша сторона не більше 1536 px.

import sharp from 'sharp';

export const MAX_SIDE = 1536;

/** Зменшує довшу сторону до MAX_SIDE (без збільшення), повертає JPEG. Оригінал не змінюється. */
export async function prepareReference(file: string): Promise<{ data: Buffer; width: number; height: number; origWidth: number; origHeight: number }> {
  const meta = await sharp(file).rotate().metadata();
  const buf = await sharp(file).rotate().flatten({ background: '#ffffff' }).resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { data: buf.data, width: buf.info.width, height: buf.info.height, origWidth: meta.width ?? 0, origHeight: meta.height ?? 0 };
}

