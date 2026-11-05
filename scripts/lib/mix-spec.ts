// Розбір розділу «Зведення» і шумів з sound.md для повного зведення фільму (scripts/mix-full.ts).
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

export interface FilmMixSpec {
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
  filmEnd: number;
  lastWordEnd: number;
}

export const DEFAULT_SFX_FADE = 1;
/** Рівень шуму, якщо числа немає, а в полі «Гучність під голосом» стоїть слово «тихо». */
export const DEFAULT_QUIET_SFX_DB = -22;

const N = '(\\d+(?:[.,]\\d+)?)';
const DB = '(-\\d+(?:[.,]\\d+)?)';
const num = (s: string): number => Number(s.replace(',', '.'));
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
  const underDb = num(under[1]!);
  const pauseDb = num(rise[1]!);
  const fade = num(rise[2]!);
  const pauseMin = pauseMinM ? num(pauseMinM[1]!) : 0.8;
  if (!pauseMinM) warnings.push('Поріг паузи не знайдено («довших за N с»), взято 0.8 с.');
  const shortRise = new RegExp(`підйом іде до\\s+${DB}\\s*дБ\\s+за\\s+${N}\\s*с`, 'i').exec(prose);
  const bumpRise = shortRise ? num(shortRise[2]!) : fade;

  // ---- відхилення від загального правила (пункти списку)
  const musicPatches: EnvPatch[] = [];
  let endFade = 0.75;
  let endSfx: { n: number } | undefined;
  let endMusicDb: number | undefined;
  let endFrom = ctx.lastWordEnd;
  let bumpFall = fade;
  for (const b of bullets) {
    if (/^\d/.test(b) && /кадр\s+\d+,\s*шум\s+\d+/i.test(b)) continue; // пункти шумів розбираються нижче
    // Фрагмент N до слова «…» (a–b с): музика -X дБ під голосом. У паузі c–d с піднімається до -Y дБ, далі до -Z дБ за T с.
    let m = new RegExp(`^Фрагмент\\s+\\d+\\s+до слова[^(]*\\(${RANGE}\\s*с\\):\\s*музика\\s+${DB}\\s*дБ.*?У паузі\\s+${RANGE}\\s*с\\s+піднімається до\\s+${DB}\\s*дБ,\\s*далі до\\s+${DB}\\s*дБ за\\s+${N}\\s*с`, 's').exec(b);
    if (m) {
      const [, , , lvl, p0, p1, peak, , fall] = m;
      bumpFall = num(fall!);
      musicPatches.push({
        label: `мовлення до паузи ${num(lvl!)} дБ, підйом у паузі ${p0}–${p1} с до ${num(peak!)} дБ`,
        points: [
          { t: 0, db: num(lvl!) },
          { t: num(p0!), db: num(lvl!) },
          { t: num(p0!) + bumpRise, db: num(peak!) },
          { t: num(p1!), db: num(peak!) },
          { t: num(p1!) + bumpFall, db: 'base' },
        ],
      });
      notes.push(`Пауза ${p0}–${p1} с: музика від ${num(lvl!)} дБ піднімається до ${num(peak!)} дБ за ${bumpRise} с і за ${bumpFall} с після паузи повертається до рівня під голосом (за правилом «підйом іде до … за ${bumpRise} с» і «далі … за ${bumpFall} с»). Лінійно в дБ; початок фільму (до першого слова) стоїть на ${num(lvl!)} дБ, бо музика грає з першої секунди.`);
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
    m = new RegExp(`^Кінець\\s*\\(${N}\\s*с[^)]*\\):\\s*музика до\\s+${DB}\\s*дБ[^]*?шум\\s+(\\d+)[^]*?останні\\s+${N}\\s*с`, 'i').exec(b);
    if (m) {
      endFrom = num(m[1]!);
      endMusicDb = num(m[2]!);
      endSfx = { n: Number(m[3]) };
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
    notes.push(`Кінець (${endFrom} с і далі): музика піднімається від -20 до ${endMusicDb} дБ рівно за ${(ctx.filmEnd - endFrom).toFixed(2)} с, до цього додається лінійне згасання амплітуди за останні ${endFade} с до кінця фільму (підйом і згасання йдуть одночасно, бо пауза лише ${(ctx.filmEnd - endFrom).toFixed(2)} с; музика ледь «виходить уперед» і гасне).`);
  }

  // ---- рівні шумів з речень (не з пунктів)
  const levels = new Map<number, number>();
  const afterLast = new Map<number, number>();
  for (const m of prose.matchAll(new RegExp(`[Шш]ум\\s+(\\d+)\\s+${DB}\\s*дБ(?:[^;.]*?після останнього слова\\s+${DB}\\s*дБ)?`, 'g'))) {
    levels.set(Number(m[1]), num(m[2]!));
    if (m[3]) afterLast.set(Number(m[1]), num(m[3]));
  }
  for (const m of prose.matchAll(new RegExp(`[Шш]уми\\s+([\\d–,\\s і-]+?)\\s+${DB}\\s*дБ`, 'g'))) {
    for (const n of parseNumberList(m[1]!)) levels.set(n, num(m[2]!));
  }
  const bumps = new Map<number, Array<{ from: number; to: number; db: number }>>();
  for (const m of prose.matchAll(new RegExp(`у паузі\\s+${RANGE}\\s*с\\s+шум\\s+(\\d+)\\s+до\\s+${DB}\\s*дБ`, 'gi'))) {
    const n = Number(m[3]);
    bumps.set(n, [...(bumps.get(n) ?? []), { from: num(m[1]!), to: num(m[2]!), db: num(m[4]!) }]);
  }

  // ---- шуми за часом (пункти «0.3–3.3 с, кадр 1, шум 2. …»)
  const timed = new Map<number, { from: number; to: number; frame: number; rest: string }>();
  for (const b of bullets) {
    const m = new RegExp(`^${RANGE}\\s*с,\\s*кадр\\s+(\\d+),\\s*шум\\s+(\\d+)\\.\\s*(.*)$`, 's').exec(b);
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
    const outLenEnd = new RegExp(`гасне за\\s+${N}\\s*с до\\s+${N}\\s*с`, 'i').exec(rest);
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
      fadeOutEnd: fadeToFilmEnd ? ctx.filmEnd : outLenEnd ? num(outLenEnd[2]!) : outEnd ? num(outEnd[1]!) : undefined,
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
      plan.patches.push({ label: `після останнього слова до ${after} дБ`, points: [{ t: endFrom, db: 'base' }, { t: ctx.filmEnd, db: after }] });
    }
    plans.push(plan);
  }
  const noLevel = plans.filter((p) => !p.levelFromDoc).map((p) => p.n);
  if (noLevel.length) {
    warnings.push(`Шуми ${noLevel.join(', ')}: у «Зведенні» немає рівня в дБ, а поле «Гучність під голосом» словесне; взято ${DEFAULT_QUIET_SFX_DB} дБ.`);
  }
  notes.push(
    'Шуми: початок файлу ставиться на секунду з поля «Де»; «Вступає за T с» це тривалість наростання з цієї секунди; «гасне до T с» означає, що згасання закінчується на T с, але не пізніше за кінець самого файлу (файл шуму не подовжується), тривалість згасання 1 с, якщо не вказана; рівень шуму береться з речення про рівні в «Зведенні», а не зі слова «тихо» в полі «Гучність під голосом».',
  );
  return { underDb, pauseDb, fade, pauseMin, musicPatches, endFade, sfx: plans, notes, warnings };
}
