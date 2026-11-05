// Розбір розділу «Зведення» і шумів з sound.md для повного зведення фільму (scripts/mix-full.ts).
//
// Усі секунди в документі рахуються від початку фільму (від музики й титра); озвучення стоїть
// у фільмі із затримкою «Озвучення стоїть у фільмі з N с» (voiceDelay). Шумів може не бути зовсім.
//
// Розділ «Зведення» написаний прозою, тому числа дістаються регулярними виразами за стабільними
// зворотами композитора («Музика під голосом -20 дБ», «Відхилення від загального правила:» з
// пунктами, «Шуми за часом» з пунктами «0.3–3.3 с, кадр 1, шум 2.», речення з рівнями шумів).
// Що не вдалося розібрати, не вгадується мовчки: воно потрапляє в warnings, а як прочитано
// неоднозначне, лишається в notes, щоб скрипт надрукував це для продюсера.
// Тут лише дані й геометрія кривих (JSON-сумісні), саме зведення рахує lib/mix.ts.

import type { SfxSpec } from './docs';

/** Точка кривої: db або число (дБ відносно голосу), або 'base' (рівень основної кривої в цей момент). */
export interface PatchPoint {
  t: number;
  db: number | 'base';
}

/** Ділянка, яка замінює основну криву на проміжку від першої до останньої точки (лінійно в дБ). */
export interface EnvPatch {
  label: string;
  points: PatchPoint[];
}

export interface SfxPlan {
  n: number;
  frame?: number;
  /** Секунда фільму, з якої звучить початок файлу. */
  start: number;
  /** Рівень відносно голосу, дБ. */
  levelDb: number;
  /** false: числа в документі не знайшлося, взято стандартний рівень для слова «тихо». */
  levelFromDoc: boolean;
  fadeIn: number;
  fadeOutLen: number;
  /** Секунда, до якої шум гасне; без неї гасне наприкінці файлу. */
  fadeOutEnd?: number;
  /** Гасне разом з кінцем фільму (а не з кінцем файлу). */
  fadeToFilmEnd: boolean;
  muffled: boolean;
  patches: EnvPatch[];
}

/** Як читати файл музики: з якої секунди файлу, з якою швидкістю, по якій ділянці міряти RMS, яке підсилення початку. */
export interface MusicSource {
  /** Секунда файлу, що стоїть на секунді фільму 0 («Музика береться з N с файлу»); 0, якщо не вказано. */
  offset: number;
  /** Швидкість читання («Швидкість читання 0.95»): секунда фільму t це секунда файлу offset + speed·t; 1, якщо не вказано. */
  speed: number;
  /** Ділянка оригінального файлу (секунди файлу), по якій рахується RMS музики; без неї весь файл. */
  rmsFrom?: number;
  rmsTo?: number;
  /** «Підсилення початку»: точки (секунда фільму, дБ), між ними лінійно, після останньої тримається останнє значення; порожньо: без підсилення. */
  boost: Array<{ t: number; db: number }>;
}

export interface FilmMixSpec {
  music: MusicSource;
  /** Секунда фільму, з якої стоїть озвучення (з документа; 0, якщо фраза відсутня). */
  voiceDelay: number;
  /** Вхід музики з нуля на початку фільму (проти клацання), секунд; 0, якщо не вказано. */
  musicFadeIn: number;
  underDb: number;
  pauseDb: number;
  fade: number;
  pauseMin: number;
  musicPatches: EnvPatch[];
  /** Наприкінці фільму музика й шуми гаснуть до нуля за стільки секунд. */
  endFade: number;
  sfx: SfxPlan[];
  notes: string[];
  warnings: string[];
}

export interface MixContext {
  /** Кінець фільму, секунди фільму. */
  filmEnd: number;
  /** Кінець останнього слова, секунди фільму (вже зі затримкою озвучення). */
  lastWordEnd: number;
}

/** Затримка озвучення з тексту «Зведення»: «Озвучення стоїть у фільмі з 3.0 с». */
export function parseVoiceDelay(text: string): number | undefined {
  const m = new RegExp(`Озвучення\\s+стоїть\\s+у\\s+фільмі\\s+з\\s+${N}\\s*с`, 'i').exec(text);
  return m ? num(m[1]!) : undefined;
}

export const DEFAULT_SFX_FADE = 1;
/** Рівень шуму, якщо числа немає, а в полі «Гучність під голосом» стоїть слово «тихо». */
export const DEFAULT_QUIET_SFX_DB = -22;

const N = '(\\d+(?:[.,]\\d+)?)';
const DB = '(-\\d+(?:[.,]\\d+)?)';
const num = (s: string): number => Number(s.replace(',', '.'));
const fmtSec = (x: number): string => String(Math.round(x * 1000) / 1000);
const RANGE = `${N}\\s*[–-]\\s*${N}`;

/** Усі шуми, назви яких у списку «шуми 3–6, 10 і 11», як номери. */
export function parseNumberList(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(/\s*(?:,|і|та)\s*/)) {
    const m = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part.trim());
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    else if (/^\d+$/.test(part.trim())) out.push(Number(part.trim()));
  }
  return out;
}

/** Секунда початку шуму з поля «Де»: «кадр 1, секунда 0.3». */
export function parseWhere(where: string): { frame?: number; second?: number } {
  const f = /кадр\s+(\d+)/i.exec(where);
  const s = new RegExp(`секунд[аиу]\\s+${N}`, 'i').exec(where);
  return { frame: f ? Number(f[1]) : undefined, second: s ? num(s[1]!) : undefined };
}

export function parseFilmMix(mixText: string, sfx: SfxSpec[], ctx: MixContext): FilmMixSpec {
  const text = mixText.replace(/−/g, '-');
  const lines = text.split('\n').map((l) => l.trim());
  const bullets = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const prose = lines.filter((l) => l && !l.startsWith('- ')).join(' ');
  const notes: string[] = [];
  const warnings: string[] = [];

  // ---- загальне правило
  const under = new RegExp(`Музика під голосом\\s+${DB}\\s*дБ`, 'i').exec(prose);
  const rise = new RegExp(`піднімається до\\s+${DB}\\s*дБ\\s+за\\s+${N}\\s*с`, 'i').exec(prose);
  const pauseMinM = new RegExp(`довших за\\s+${N}\\s*с`, 'i').exec(prose);
  if (!under || !rise) throw new Error('У розділі «Зведення» файлу sound.md не знайдено загального правила («Музика під голосом -N дБ … піднімається до -M дБ за T с»). Роль: composer.');
  const voiceDelay = parseVoiceDelay(prose) ?? 0;
  const underDb = num(under[1]!);
  const pauseDb = num(rise[1]!);
  const fade = num(rise[2]!);
  const pauseMin = pauseMinM ? num(pauseMinM[1]!) : 0.8;
  if (!pauseMinM) warnings.push('Поріг паузи не знайдено («довших за N с»), взято 0.8 с.');
  const shortRise = new RegExp(`підйом іде до\\s+${DB}\\s*дБ\\s+за\\s+${N}\\s*с`, 'i').exec(prose);
  const bumpRise = shortRise ? num(shortRise[2]!) : fade;

  // Рівні шумів: або списком («шум 3: -22, у паузі 5.36–6.32 с -14;»), або реченням («Шум 2 -20 дБ …»).
  const levels = new Map<number, number>();
  const afterLast = new Map<number, { db: number; from?: number }>();
  const bumps = new Map<number, Array<{ from: number; to: number; db: number }>>();

  // ---- відхилення від загального правила (пункти списку)
  const musicPatches: EnvPatch[] = [];
  let endFade = 0.75;
  let endSfx: { n: number } | undefined;
  let endMusicDb: number | undefined;
  let endFrom = ctx.lastWordEnd;
  let bumpFall = fade;
  let musicFadeIn = 0;
  const music: MusicSource = { offset: 0, speed: 1, boost: [] };
  for (const b of bullets) {
    // Параметри читання файлу музики (див. розділ «Зведення»: «Файл музики і як його читати»).
    const off = new RegExp(`^Музика береться з\\s+${N}\\s*с файлу`, 'i').exec(b);
    if (off) {
      music.offset = num(off[1]!);
      notes.push(`Музика береться з ${music.offset} с файлу: секунда фільму 0 це секунда файлу ${music.offset}.`);
      continue;
    }
    const spd = new RegExp(`^Швидкість читання\\s+${N}`, 'i').exec(b);
    if (spd) {
      music.speed = num(spd[1]!);
      if (!(music.speed > 0.5 && music.speed < 2)) throw new Error(`У «Зведенні» швидкість читання музики ${music.speed} поза межами 0.5–2. Роль: composer.`);
      notes.push(`Швидкість читання ${music.speed}: секунда фільму t це секунда файлу ${music.offset} + ${music.speed}·t (змінюється й тональність, asetrate).`);
      continue;
    }
    const rmsM = new RegExp(`^Нормування:[^]*?оригінальному файлу від\\s+${N}\\s*с\\s+до\\s+${N}\\s*с`, 'i').exec(b);
    if (rmsM) {
      music.rmsFrom = num(rmsM[1]!);
      music.rmsTo = num(rmsM[2]!);
      notes.push(`RMS музики рахується по оригінальному файлу від ${music.rmsFrom} до ${music.rmsTo} с.`);
      continue;
    }
    if (/^Підсилення початку/i.test(b)) {
      const body = b.slice(b.indexOf(':') + 1).split(/далі/i)[0]!;
      for (const m of body.matchAll(new RegExp(`${N}\\s*с\\s+([+-]?\\d+(?:[.,]\\d+)?)`, 'g'))) music.boost.push({ t: num(m[1]!), db: num(m[2]!) });
      const tail = /далі\s+([+-]?\d+(?:[.,]\d+)?)/i.exec(b);
      const last = music.boost[music.boost.length - 1];
      if (tail && last && num(tail[1]!) !== last.db) music.boost.push({ t: last.t + 0.001, db: num(tail[1]!) });
      if (music.boost.length < 2 || music.boost.some((p, i) => i > 0 && p.t < music.boost[i - 1]!.t)) {
        warnings.push(`Підсилення початку не розібрано (потрібні точки «N с ±X», що зростають за часом): «${b.slice(0, 90)}».`);
        music.boost = [];
      } else notes.push(`Підсилення початку (дБ, лінійно за секундою фільму, додається до рівнів зведення): ${music.boost.map((p) => `${p.t} с ${p.db > 0 ? '+' : ''}${p.db}`).join(', ')}.`);
      continue;
    }
    if (/^\d/.test(b) && /^[\d.,]+\s*[–-]\s*[\d.,]+\s*с,\s*кадр\s+\d+/i.test(b)) continue; // пункти шумів за часом розбираються нижче
    // шум N: -X[, у паузі a–b с -Y][, після останнього слова[ (з T с)] -Z];
    const lv = new RegExp(`^шум\\s+(\\d+):\\s*${DB}(?:\\s*дБ)?((?:\\s*,[^;]*?\\s${DB}(?:\\s*дБ)?)*)\\s*[;.]?$`, 'i').exec(b);
    if (lv) {
      const n = Number(lv[1]);
      levels.set(n, num(lv[2]!));
      for (const part of (lv[3] ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        const pb = new RegExp(`^у паузі\\s+${RANGE}\\s*с\\s+${DB}`, 'i').exec(part);
        const al = new RegExp(`^після останнього слова(?:\\s*\\(з\\s+${N}\\s*с\\))?\\s+${DB}`, 'i').exec(part);
        if (pb) bumps.set(n, [...(bumps.get(n) ?? []), { from: num(pb[1]!), to: num(pb[2]!), db: num(pb[3]!) }]);
        else if (al) afterLast.set(n, { db: num(al[2]!), from: al[1] ? num(al[1]) : undefined });
        else warnings.push(`Рівні шуму ${n}: частину «${part}» не розібрано, пропущено.`);
      }
      continue;
    }
    // Початок (титр, a–b с): музика на -X дБ, …; від t с вона спадає до -Y дБ за T с, … Вхід на 0 с із нуля за F с …
    let m = new RegExp(`^Початок\\s*\\([^)]*?${RANGE}\\s*с\\):\\s*музика\\s+(?:на\\s+)?${DB}\\s*дБ[^]*?від\\s+${N}\\s*с[^]*?спадає до\\s+${DB}\\s*дБ\\s+за\\s+${N}\\s*с`, 'i').exec(b);
    if (m) {
      const [a, z, hi, from, lo, len] = [num(m[1]!), num(m[2]!), num(m[3]!), num(m[4]!), num(m[5]!), num(m[6]!)];
      const pts: PatchPoint[] = [{ t: a, db: hi }, { t: from, db: hi }, { t: from + len, db: lo }];
      if (z > from + len) pts.push({ t: z, db: lo });
      musicPatches.push({ label: `початок: ${hi} дБ до ${from} с, спад до ${lo} дБ за ${len} с`, points: pts });
      const fin = new RegExp(`Вхід на\\s+${N}\\s*с\\s+із нуля за\\s+${N}\\s*с`, 'i').exec(b);
      if (fin) {
        musicFadeIn = num(fin[2]!);
        if (num(fin[1]!) !== 0) warnings.push(`Початок: вхід музики «на ${fin[1]} с» не з 0 с; вхід з нуля за ${fin[2]} с застосовано на початку фільму.`);
      }
      notes.push(`Початок (${a}–${z} с): музика на ${hi} дБ до ${from} с, далі лінійно в дБ до ${lo} дБ за ${len} с (на ${fmtSec(from + len)} с вона вже на рівні під голосом)${fin ? `; вхід з нуля за ${musicFadeIn} с на самому початку` : ''}.`);
      continue;
    }
    // Фрагмент N до слова «…» (a–b с): музика -X дБ під голосом. У паузі c–d с піднімається до -Y дБ, далі до -Z дБ за T с.
    m = new RegExp(`^Фрагмент\\s+\\d+\\s+до слова[^(]*\\(${RANGE}\\s*с\\):\\s*музика\\s+${DB}\\s*дБ.*?У паузі\\s+${RANGE}\\s*с\\s+піднімається до\\s+${DB}\\s*дБ,\\s*далі до\\s+${DB}\\s*дБ за\\s+${N}\\s*с`, 's').exec(b);
    if (m) {
      const [, rangeFrom, , lvl, p0, p1, peak, , fall] = m;
      bumpFall = num(fall!);
      musicPatches.push({
        label: `мовлення до паузи ${num(lvl!)} дБ, підйом у паузі ${p0}–${p1} с до ${num(peak!)} дБ`,
        points: [
          { t: num(rangeFrom!), db: num(lvl!) },
          { t: num(p0!), db: num(lvl!) },
          { t: num(p0!) + bumpRise, db: num(peak!) },
          { t: num(p1!), db: num(peak!) },
          { t: num(p1!) + bumpFall, db: 'base' },
        ],
      });
      notes.push(`Пауза ${p0}–${p1} с: музика від ${num(lvl!)} дБ піднімається до ${num(peak!)} дБ за ${bumpRise} с і за ${bumpFall} с після паузи повертається до рівня під голосом (за правилом «підйом іде до … за ${bumpRise} с» і «далі … за ${bumpFall} с»). Лінійно в дБ; мовлення від ${rangeFrom} с до паузи стоїть на ${num(lvl!)} дБ.`);
      continue;
    }
    // Кадр N (…, від a с, … і до початку фрагмента M на b с): музика не піднімається, а тримається на -X дБ … за T с після початку фрагмента M.
    m = new RegExp(`^Кадр\\s+\\d+[^(]*\\(від\\s+${N}\\s*с[^)]*?на\\s+${N}\\s*с\\)[^]*?тримається на\\s+${DB}\\s*дБ[^]*?за\\s+${N}\\s*с після початку`, 'i').exec(b);
    if (m) {
      const from = num(m[1]!);
      const to = num(m[2]!);
      const level = num(m[3]!);
      const back = num(m[4]!);
      musicPatches.push({
        label: `тиха нота ${level} дБ від ${from} до ${to} с`,
        points: [
          { t: from, db: 'base' },
          { t: from + fade, db: level },
          { t: to, db: level },
          { t: to + back, db: 'base' },
        ],
      });
      notes.push(`Від ${from} с до ${to} с музика тримається на ${level} дБ (піднімається до цього рівня за ${fade} с після ${from} с, повертається до рівня під голосом за ${back} с після ${to} с); шумів немає.`);
      continue;
    }
    // Кінець (a с і далі): музика до -X дБ, шум N теж виходить уперед, останні T с обидва плавно гаснуть до кінця фільму.
    m = new RegExp(`^Кінець\\s*\\(${N}\\s*с[^)]*\\):\\s*музика до\\s+${DB}\\s*дБ(?:[^]*?шум\\s+(\\d+))?[^]*?останні\\s+${N}\\s*с`, 'i').exec(b);
    if (m) {
      endFrom = num(m[1]!);
      endMusicDb = num(m[2]!);
      endSfx = m[3] ? { n: Number(m[3]) } : undefined;
      endFade = num(m[4]!);
      continue;
    }
    // Діапазон у дужках і рівень музики: «Фрагмент 16 (100.61–109.6 с): музика -22 дБ», «Кадр 18 («букет», 72.2–76.3 с): …, музика на -20 дБ».
    m = new RegExp(`^(?:Кадр|Фрагмент)\\s+\\d+[^(]*\\([^)]*?${RANGE}\\s*с\\)[^]*?музика\\s+(?:на\\s+)?${DB}\\s*дБ`, 'i').exec(b);
    if (m) {
      const from = num(m[1]!);
      const to = num(m[2]!);
      const level = num(m[3]!);
      musicPatches.push({
        label: `${level} дБ від ${from} до ${to} с`,
        points: [
          { t: Math.max(0, from - fade), db: 'base' },
          { t: from, db: level },
          { t: to, db: level },
          { t: to + fade, db: 'base' },
        ],
      });
      continue;
    }
    warnings.push(`Пункт «Зведення» не розібрано, пропущено: «${b.slice(0, 90)}${b.length > 90 ? '…' : ''}».`);
  }
  if (endMusicDb !== undefined) {
    musicPatches.push({
      label: `кінець: музика до ${endMusicDb} дБ`,
      points: [
        { t: endFrom, db: 'base' },
        { t: ctx.filmEnd, db: endMusicDb },
      ],
    });
    notes.push(`Кінець (${endFrom} с і далі): музика піднімається від рівня під голосом до ${endMusicDb} дБ рівно за ${(ctx.filmEnd - endFrom).toFixed(2)} с, до цього додається лінійне згасання амплітуди за останні ${endFade} с до кінця фільму (підйом і згасання йдуть одночасно, бо пауза лише ${(ctx.filmEnd - endFrom).toFixed(2)} с; музика ледь «виходить уперед» і гасне).`);
  }

  // ---- рівні шумів з речень (не з пунктів)
  for (const m of prose.matchAll(new RegExp(`[Шш]ум\\s+(\\d+)\\s+${DB}\\s*дБ(?:[^;.]*?після останнього слова\\s+${DB}\\s*дБ)?`, 'g'))) {
    levels.set(Number(m[1]), num(m[2]!));
    if (m[3]) afterLast.set(Number(m[1]), { db: num(m[3]) });
  }
  for (const m of prose.matchAll(new RegExp(`[Шш]уми\\s+([\\d–,\\s і-]+?)\\s+${DB}\\s*дБ`, 'g'))) {
    for (const n of parseNumberList(m[1]!)) levels.set(n, num(m[2]!));
  }
  for (const m of prose.matchAll(new RegExp(`у паузі\\s+${RANGE}\\s*с\\s+шум\\s+(\\d+)\\s+до\\s+${DB}\\s*дБ`, 'gi'))) {
    const n = Number(m[3]);
    bumps.set(n, [...(bumps.get(n) ?? []), { from: num(m[1]!), to: num(m[2]!), db: num(m[4]!) }]);
  }

  // ---- шуми за часом (пункти «0.3–3.3 с, кадр 1, шум 2. …»)
  const timed = new Map<number, { from: number; to: number; frame: number; rest: string }>();
  for (const b of bullets) {
    const m = new RegExp(`^${RANGE}\\s*с,\\s*кадр\\s+(\\d+)(?:\\s*\\([^)]*\\))?,\\s*шум\\s+(\\d+)\\.\\s*(.*)$`, 's').exec(b);
    if (m) timed.set(Number(m[4]), { from: num(m[1]!), to: num(m[2]!), frame: Number(m[3]), rest: m[5]! });
  }

  const plans: SfxPlan[] = [];
  for (const s of sfx) {
    const t = timed.get(s.n);
    const where = parseWhere(s.where);
    const start = where.second ?? t?.from;
    if (start === undefined) {
      warnings.push(`Шум ${s.n}: у «Де» немає секунди, а в «Шуми за часом» немає пункту; шум не підмішано.`);
      continue;
    }
    if (t && where.second !== undefined && Math.abs(t.from - where.second) > 0.05) {
      warnings.push(`Шум ${s.n}: «Де» каже секунду ${where.second}, а пункт «Шуми за часом» ${t.from}; взято «Де».`);
    }
    const rest = t?.rest ?? '';
    const fin = new RegExp(`[Вв]ступає за\\s+${N}\\s*с`).exec(rest);
    const outLenEnd = new RegExp(`гасне за\\s+${N}\\s*с(?:\\s+з\\s+${N})?\\s+до\\s+${N}\\s*с`, 'i').exec(rest);
    const outEnd = new RegExp(`гасне до\\s+${N}\\s*с`, 'i').exec(rest);
    const outLast = /гасне за останню секунду/i.test(rest);
    const levelDoc = levels.get(s.n);
    const fadeToFilmEnd = endSfx?.n === s.n;
    const plan: SfxPlan = {
      n: s.n,
      frame: where.frame ?? t?.frame,
      start,
      levelDb: levelDoc ?? DEFAULT_QUIET_SFX_DB,
      levelFromDoc: levelDoc !== undefined,
      fadeIn: fin ? num(fin[1]!) : DEFAULT_SFX_FADE,
      fadeOutLen: fadeToFilmEnd ? endFade : outLenEnd ? num(outLenEnd[1]!) : outLast ? 1 : DEFAULT_SFX_FADE,
      fadeOutEnd: fadeToFilmEnd ? ctx.filmEnd : outLenEnd ? num(outLenEnd[3]!) : outEnd ? num(outEnd[1]!) : undefined,
      fadeToFilmEnd,
      muffled: /приглушено/i.test(rest),
      patches: [],
    };
    for (const bp of bumps.get(s.n) ?? []) {
      plan.patches.push({
        label: `у паузі ${bp.from}–${bp.to} с до ${bp.db} дБ`,
        points: [
          { t: bp.from, db: 'base' },
          { t: bp.from + bumpRise, db: bp.db },
          { t: bp.to, db: bp.db },
          { t: bp.to + bumpFall, db: 'base' },
        ],
      });
    }
    const after = afterLast.get(s.n);
    if (after !== undefined) {
      plan.patches.push({ label: `після останнього слова до ${after.db} дБ`, points: [{ t: after.from ?? endFrom, db: 'base' }, { t: ctx.filmEnd, db: after.db }] });
    }
    plans.push(plan);
  }
  const noLevel = plans.filter((p) => !p.levelFromDoc).map((p) => p.n);
  if (noLevel.length) {
    warnings.push(`Шуми ${noLevel.join(', ')}: у «Зведенні» немає рівня в дБ, а поле «Гучність під голосом» словесне; взято ${DEFAULT_QUIET_SFX_DB} дБ.`);
  }
  if (sfx.length) notes.push(
    'Шуми: початок файлу ставиться на секунду з поля «Де»; «Вступає за T с» це тривалість наростання з цієї секунди; «гасне до T с» означає, що згасання закінчується на T с, але не пізніше за кінець самого файлу (файл шуму не подовжується), тривалість згасання 1 с, якщо не вказана; рівень шуму береться зі списку «шум N: -X» (або з речення про рівні) у «Зведенні», а не зі слова «тихо» в полі «Гучність під голосом».',
  );
  return { music, voiceDelay, musicFadeIn, underDb, pauseDb, fade, pauseMin, musicPatches, endFade, sfx: plans, notes, warnings };
}
