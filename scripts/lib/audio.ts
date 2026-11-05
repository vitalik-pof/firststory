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

/** Кількість каналів першого аудіопотоку (1 чи 2). */
export function probeChannels(file: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const v = parseInt(r.stdout.trim(), 10);
  return v === 2 ? 2 : 1;
}

/** З'єднує MP3-файли з паузою тиші між ними (перекодування в MP3 із заданим бітрейтом). */
export function concatMp3(inputs: string[], gapSeconds: number, output: string, kbps = 128): void {
  const layout = probeChannels(inputs[0]!) === 2 ? 'stereo' : 'mono';
  const args = ['-y', '-v', 'error'];
  const labels: string[] = [];
  const filters: string[] = [];
  let idx = 0;
  inputs.forEach((f, i) => {
    if (i > 0 && gapSeconds > 0) {
      args.push('-f', 'lavfi', '-t', String(gapSeconds), '-i', `anullsrc=r=44100:cl=${layout}`);
      filters.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=${layout}[a${idx}]`);
      labels.push(`[a${idx}]`);
      idx++;
    }
    args.push('-i', f);
    filters.push(`[${idx}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=${layout}[a${idx}]`);
    labels.push(`[a${idx}]`);
    idx++;
  });
  args.push('-filter_complex', `${filters.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`, '-map', '[out]', '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, output);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg не зміг з'єднати частини озвучення: ${r.stderr}`);
}
