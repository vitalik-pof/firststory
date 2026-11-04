// Допоміжне для аудіо: тривалість через ffprobe, кодування в MP3 через ffmpeg.

import { spawnSync } from 'node:child_process';

export function hasBinary(name: string): boolean {
  return spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
}

/** Тривалість аудіофайла в секундах (ffprobe) або undefined, якщо ffprobe недоступний. */
export function probeDuration(file: string): number | undefined {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  const v = parseFloat(r.stdout.trim());
  return Number.isFinite(v) ? v : undefined;
}

/** Перекодовує в MP3 із заданим бітрейтом (для сторінки огляду). */
export function encodeMp3(input: string, output: string, kbps: number): void {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, output], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg не зміг перекодувати ${input}: ${r.stderr}`);
}
