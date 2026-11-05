// HTML сторінки огляду Етапу 1. Два режими:
//  - artifact: фрагмент для публікації на claude.ai (починається з meta і title, без doctype/html/head/body);
//  - pages: повний самостійний документ для GitHub Pages (підкаталог, лише відносні посилання).

import { buildSchedule } from './animatic';
import type { DirectorQuestions, RoleDecision } from './docs';
import type { Manifest } from './manifest';
import type { VoiceDoc, VoiceEntry } from './docs';
import { parseVoiceDelay } from './mix-spec';
import type { QuestionBlock, ReviewData } from './review-build';
import type { PhotoRefBlock } from './review-refs';
import type { TimingsFile } from './timings';
import type { TitleCard } from './title-card';
import { CLIENT_JS, CSS } from './review-assets';
import type { Role } from './md';

export type ReviewTarget = 'artifact' | 'pages';

export const ROLE_LABEL: Record<Role, string> = {
  producer: 'Технічний продюсер',
  scenarist: 'Сценарист',
  'art-director': 'Художник-постановник',
  'voice-director': 'Режисер озвучення',
  composer: 'Композитор-звукорежисер',
  editor: 'Монтажер',
};

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
}

/** Мінімальний markdown: абзаци, списки, заголовки четвертого рівня, **жирний**, *курсив*, `код`. */
export function mdLite(text: string): string {
  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = (): void => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^#{3,6}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      out.push(`<h4>${inline(h[1]!)}</h4>`);
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)![1]!);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

/**
 * Три частини замість одного блоку питань: «Потрібне ваше рішення» (угорі), «Що вирішено без вас» і
 * згорнута довідка «Усі питання ролей» (унизу). Повертає секції як [id, заголовок, html].
 */
export function decisionSections(o: { roleDecisions?: RoleDecision[]; director: DirectorQuestions; producerDecisions: string[]; questions: QuestionBlock[] }): { top: Array<[string, string, string]>; bottom: Array<[string, string, string]> } {
  const top: Array<[string, string, string]> = [];
  const bottom: Array<[string, string, string]> = [];
  const items = o.director.items;
  top.push([
    'need-decision',
    'Потрібне ваше рішення',
    items.length
      ? `${o.director.updated ? `<p class="muted">Оновлено: ${esc(o.director.updated)}. Якщо не відповісте, діє значення за замовчуванням.</p>` : ''}` +
        items
          .map(
            (q) => `<div class="card decision" id="decision-${q.n}"><h3>${q.n}. ${esc(q.title)}</h3>
<p>${inline(q.question)}</p>
<p class="rec"><strong>Рекомендація продюсера:</strong> ${inline(q.recommendation)}</p>
<p class="def"><strong>За замовчуванням:</strong> ${inline(q.defaultValue)}</p></div>`,
          )
          .join('\n')
      : '<p class="muted">Рішень від вас зараз не потрібно.</p>',
  ]);
  if (o.roleDecisions?.length) bottom.push(['role-decisions', 'Рішення ролей', renderRoleDecisions(o.roleDecisions)]);
  if (o.producerDecisions.length) {
    bottom.push(['decided', 'Що вирішено без вас', `<ul>${o.producerDecisions.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`]);
  }
  bottom.push([
    'role-questions',
    'Усі питання ролей (довідка)',
    `<details><summary>Показати питання, які ролі лишили у своїх файлах</summary><p class="muted">Це довідка. Відповідати на ці питання не потрібно: їх розбирає технічний продюсер, а вам лишаються тільки рішення зі списку «Потрібне ваше рішення».</p>${
      o.questions.length
        ? o.questions.map((q) => `<div class="card"><h3 style="margin-top:0">${esc(ROLE_LABEL[q.role])} <span class="muted">(${esc(q.file)})</span></h3>${mdLite(q.text)}</div>`).join('\n')
        : '<p class="muted">Питань немає.</p>'
    }</details>`,
  ]);
  return { top, bottom };
}

const ROLE_ORDER = ['scenarist', 'art-director', 'voice-director', 'composer', 'editor', 'producer'];

/** Рішення ролей за ролями: що вирішено видно одразу, «чому» і «що було б інакше» розгортаються. */
export function renderRoleDecisions(list: RoleDecision[]): string {
  const roles = [...new Set(list.map((x) => x.role))].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return `<p class="lead">Кожна роль записує свої рішення у файл. Тут видно, що вирішено; «Чому» і «Що було б інакше» розгортаються.</p>` + roles
    .map((role) => {
      const mine = list.filter((x) => x.role === role);
      const label = (ROLE_LABEL as Record<string, string>)[role] ?? role;
      const groups = [...new Set(mine.map((x) => `${x.date}: ${x.topic}`))];
      return `<h3>${esc(label)}</h3>` + groups
        .map((g) => {
          const items = mine.filter((x) => `${x.date}: ${x.topic}` === g);
          return `<p class="muted" style="margin-bottom:4px">${esc(g)}${items[0]!.scope === '_project' ? ' (на весь проєкт)' : ''}</p>` + items
            .map(
              (x) => `<div class="card rdec"><strong>${esc(x.name)}</strong><p style="margin:4px 0 0">${inline(x.decided)}</p><details><summary>Чому і що було б інакше</summary><p><strong>Чому:</strong> ${inline(x.why)}</p><p><strong>Що було б інакше:</strong> ${inline(x.alternative)}</p></details></div>`,
            )
            .join('\n');
        })
        .join('\n');
    })
    .join('\n');
}

/** Фото-референси з атрибуцією: мініатюра, автор, ліцензія з посиланням, джерело з посиланням. */
export function renderPhotoRefs(blocks: PhotoRefBlock[], rel: (key: string) => string | undefined): string {
  if (!blocks.length) return '';
  const link = (url: string, text: string): string => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
  return (
    '<p class="lead">Фото реальних українських об\'єктів, які використано як референси для генератора. Автори й ліцензії вказані згідно з умовами ліцензій.</p>' +
    blocks
      .map(
        (b) => `<div class="card"><h3 style="margin-top:0">${esc(b.object.name)} <span class="muted">(${esc(b.object.id)})</span></h3><p class="muted">Використано: ${esc(b.usedIn.join(', '))}</p><div class="sheets">${
          b.photos
            .map((p) => {
              if (p.source.licenseKind === 'director') return '<p class="muted">використано фото, надане режисером; на сторінку не виводиться</p>';
              const src = rel(p.key);
              return `<figure class="sheet" style="margin:0">${src ? `<img src="${esc(src)}" alt="${esc(b.object.name)}" loading="lazy">` : '<div class="ph" style="aspect-ratio:4/3">Файлу немає</div>'}<figcaption class="muted">Автор: ${esc(p.source.author)}<br>Ліцензія: ${link(p.source.licenseUrl, p.source.license)}<br>Джерело: ${link(p.source.source, 'сторінка фото')}</figcaption></figure>`;
            })
            .join('')
        }</div></div>`,
      )
      .join('\n')
  );
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function renderReview(d: ReviewData, target: ReviewTarget, title: string, available: Set<string>): string {
  const rel = (key: string): string | undefined => (available.has(key) ? d.media.find((m) => m.key === key)?.rel : undefined);
  const fragText = new Map(d.script.fragments.map((f) => [f.n, f.text]));
  const timingOf = new Map((d.timings?.fragments ?? []).map((f) => [f.n, f]));
  const sections: string[] = [];
  const nav: Array<[string, string]> = [];
  const section = (id: string, heading: string, body: string): void => {
    nav.push([id, heading]);
    sections.push(`<section id="${id}">\n<h2>${esc(heading)}</h2>\n${body}\n</section>`);
  };

  for (const [id, hd, body] of decisionSections({ roleDecisions: d.roleDecisions, director: d.directorQuestions, producerDecisions: d.producerDecisions, questions: d.questions }).top) section(id, hd, body);

  // ---------------- аніматик
  const frames = d.storyboard?.frames ?? [];
  // Титр показуємо лише коли плеєр грає зведення (воно вже має 3 с музики перед голосом) і затримка озвучення відома з sound.md.
  const delay = (d.sound ? parseVoiceDelay(d.sound.mix) : undefined) ?? 0;
  const titleOn = !!d.titleCard && !!rel('film-mix') && delay > 0;
  const animBody = renderAnimatic({
    timings: d.timings,
    audioSrc: rel('film-mix') ?? rel('narration'),
    items: frames.map((f) => ({ n: f.n, fragment: f.fragment, src: rel(`frame:${f.n}`) })),
    word: 'кадр',
    title: titleOn ? d.titleCard : undefined,
    offset: titleOn ? delay : 0,
    intro: `Чорновий перегляд: ${titleOn ? 'спершу початковий титр (малює код за edit.md), далі ' : ''}кадри розкадровки змінюються під ${rel('film-mix') ? `повне зведення фільму (озвучення${d.sound?.sfx.length ? ' з музикою й шумами' : ' з музикою'} за звуковим брифом)` : 'озвучення'}. Кадр з'являється, коли голос доходить до початку його фрагмента${titleOn ? ` (час озвучення зсунуто на ${delay} с титру)` : ''}; якщо на фрагмент кілька кадрів, його час ділиться між ними порівну. Звук стартує після натискання «Грати».`,
  });
  section('animatic-section', 'Аніматик', animBody);

  // ---------------- сценарій
  section(
    'script',
    'Сценарій',
    `<p class="lead">${esc(d.script.title)}. Мова озвучення: ${esc(d.script.language)}.</p>
${d.script.fragments.map((f) => `<div class="card"><span class="badge">Фрагмент ${f.n}</span>${timingOf.get(f.n) ? `<span class="badge">${fmtTime(timingOf.get(f.n)!.start)}</span>` : (d.timings?.silent_fragments ?? []).includes(f.n) ? '<span class="badge">без голосу (титр)</span>' : ''}<p style="margin-top:8px">${esc(f.text)}</p></div>`).join('\n')}
${d.script.changes ? `<h3>Що змінено порівняно з оригіналом і чому</h3>${mdLite(d.script.changes)}` : ''}`,
  );

  // ---------------- стиль і герої
  let styleBody = '';
  if (d.style) {
    styleBody += `${mdLite(d.style.overview)}<details><summary>Текст стилю для генератора</summary><pre>${esc(d.style.generatorText)}</pre></details>`;
  } else styleBody += '<div class="note">art/style.md ще немає.</div>';
  for (const c of d.characters) {
    const sheets = c.sheets
      .map((s) => {
        const src = rel(`sheet:${c.id}/${s.slug}`);
        return `<figure class="sheet" style="margin:0">${src ? `<img src="${esc(src)}" alt="Аркуш: ${esc(c.name)} ${esc(s.label)}" loading="lazy">` : '<div class="ph" style="aspect-ratio:16/9">Аркуш ще не згенеровано</div>'}<figcaption class="muted">${esc(c.name)}${s.label === 'main' ? '' : `, версія «${esc(s.label)}»`}</figcaption><details><summary>Текст для генератора</summary><pre>${esc(s.prompt)}</pre></details></figure>`;
      })
      .join('\n');
    styleBody += `<div class="card"><h3 style="margin-top:0">${esc(c.name)}</h3>${c.appears ? `<p class="muted">З'являється в: ${esc(c.appears)}</p>` : ''}${mdLite(c.description)}${c.extraSections.map((x) => `<h4>${esc(x.title)}</h4>${mdLite(x.text)}`).join('')}<div class="sheets">${sheets}</div>${c.acceptance ? `<h4>Приймання</h4>${mdLite(c.acceptance)}` : ''}</div>`;
  }
  section('style', 'Стиль і герої', `<h3 style="margin-top:0">Візуальний стиль</h3>${styleBody}`);

  // ---------------- розкадровка
  if (d.storyboard) {
    const cards = frames
      .map((f) => {
        const src = rel(`frame:${f.n}`);
        const t = timingOf.get(f.n);
        const sameFrag = frames.filter((x) => x.fragment === f.fragment);
        const k = sameFrag.findIndex((x) => x.n === f.n) + 1;
        return `<div class="card frame-card" id="frame-${f.n}">
  <div class="thumb">${src ? `<img src="${esc(src)}" alt="Кадр ${f.n}" loading="lazy">` : `<div class="ph">Кадр ${f.n} ще не згенеровано</div>`}</div>
  <div>
    <p><span class="badge">Кадр ${f.n}</span><span class="badge">Фрагмент ${f.fragment}${sameFrag.length > 1 ? `, кадр ${k} з ${sameFrag.length}` : ''}</span>${t ? `<span class="badge">${fmtTime(t.start)}–${fmtTime(t.end)}</span>` : ''}</p>
    <p class="frag-text">${esc(fragText.get(f.fragment) ?? '')}</p>
    ${f.inFrame ? `<p><strong>У кадрі:</strong> ${esc(f.inFrame)}</p>` : ''}
    ${f.camera ? `<p><strong>Камера:</strong> ${esc(f.camera)}</p>` : ''}
    ${f.mood ? `<p><strong>Світло і настрій:</strong> ${esc(f.mood)}</p>` : ''}
    <p class="muted"><strong>Герої:</strong> ${f.heroes.length ? f.heroes.map((h) => esc(h.id + (h.version ? ` «${h.version}»` : ''))).join(', ') : 'немає'}</p>
    <details><summary>Текст для генератора</summary><pre>${esc(f.prompt)}</pre></details>
  </div>
</div>`;
      })
      .join('\n');
    section('storyboard', 'Розкадровка', `<p class="lead">Формат кадру: ${esc(d.storyboard.format)}</p>${cards}${d.storyboard.acceptance ? `<h3>Приймання кадрів</h3>${mdLite(d.storyboard.acceptance)}` : ''}`);
  } else section('storyboard', 'Розкадровка', '<div class="note">storyboard.md ще немає.</div>');

  const photoHtml = renderPhotoRefs(d.photoRefs, rel);
  if (photoHtml) section('photo-refs', 'Фото-референси', photoHtml);

  // ---------------- голос
  section('voice', 'Голос і озвучення', renderVoiceBody({ voice: d.voice, previews: d.previews, rel, timings: d.timings, voiceMd: d.voiceMd }));

  // ---------------- звук
  let soundBody = '';
  if (d.sound) {
    const s = d.sound;
    soundBody += `${s.totalSeconds ? `<p class="lead">Загальна тривалість: ${s.totalSeconds} с.</p>` : ''}${s.idea ? `<h3 style="margin-top:0">Задум</h3>${mdLite(s.idea)}` : ''}`;
    soundBody += `<h3>Музика</h3><div class="card">${rel('music') ? `<audio controls preload="none" src="${esc(rel('music')!)}"></audio>` : '<div class="note">Музики ще немає (крок 10).</div>'}<p class="muted">${s.music.seconds} с, ${s.music.instrumental ? 'інструментальна' : 'з голосом'}</p><details><summary>Текст для генератора</summary><pre>${esc(s.music.prompt)}</pre></details>${s.music.development ? `<h4>Розвиток по фільму</h4>${mdLite(s.music.development)}` : ''}</div>`;
    soundBody += `<h3>Шуми</h3>${s.sfx.length ? s.sfx.map((x) => `<div class="card"><span class="badge">Шум ${x.n}</span><span class="badge">${x.seconds} с</span>${rel(`sfx:${x.n}`) ? `<audio controls preload="none" src="${esc(rel(`sfx:${x.n}`)!)}"></audio>` : '<div class="note">Файлу ще немає.</div>'}${x.where ? `<p><strong>Де:</strong> ${esc(x.where)}</p>` : ''}${x.loudness ? `<p><strong>Гучність під голосом:</strong> ${esc(x.loudness)}</p>` : ''}<details><summary>Текст для генератора</summary><pre>${esc(x.prompt)}</pre></details></div>`).join('\n') : '<p class="muted">Шумів у звуковому брифі немає.</p>'}`;
    if (s.mix) soundBody += `<h3>Зведення (задум)</h3>${mdLite(s.mix)}`;
  } else soundBody = '<div class="note">sound.md ще немає (крок 9).</div>';
  section('sound', 'Звуковий бриф, музика і шуми', soundBody);

  // ---------------- рішення ролей, питання
  for (const [id, hd, body] of decisionSections({ roleDecisions: d.roleDecisions, director: d.directorQuestions, producerDecisions: d.producerDecisions, questions: d.questions }).bottom) section(id, hd, body);

  // ---------------- кредити
  section('credits', 'Витрачені кредити', renderCredits(d.manifest));

  const lead = `${d.script.title}. Сирий матеріал першого прогону: без зведення звуку, монтажу, руху камери й субтитрів.`;
  return wrapPage(target, title, lead, nav, sections, d.warnings);
}

export function wrapPage(target: ReviewTarget, title: string, lead: string, nav: Array<[string, string]>, sections: string[], warnings: string[]): string {
  const warn = warnings.length ? `<div class="note"><strong>Чого бракує на цій збірці:</strong><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  const head = `<h1>${esc(title)}</h1>\n<p class="lead">${esc(lead)}</p>\n<nav class="toc">${nav.map(([id, h]) => `<a href="#${id}">${esc(h)}</a>`).join('')}</nav>\n${warn}`;
  const content = `<div class="page">\n${head}\n${sections.join('\n')}\n</div>\n<script>${CLIENT_JS}</script>`;
  if (target === 'artifact') {
    return `<meta name="claude:viewport-fit-sides" content="cover">\n<title>${esc(title)}</title>\n<style>${CSS}</style>\n${content}\n`;
  }
  return `<!doctype html>\n<html lang="uk">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<link rel="icon" href="data:,">\n<title>${esc(title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n${content}\n</body>\n</html>\n`;
}

export interface AnimaticItem {
  n: number;
  fragment: number;
  src?: string;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Початковий титр на сцені аніматика. Тло: основа кольору паперу (під кадром), кадр 1 (його розмиває,
 * знебарвлює й збільшує код сторінки за часом), паперова вуаль, пляма світла, зернистість і потемніння;
 * поверх них текст і риска. Усе (кольори, розміри, положення) з edit.md через TitleCard; розміри в cqw
 * від ширини сцени (кадр 1080 px завширшки), тому масштаб збігається з кадром. Блок тексту завширшки
 * blockWidth стоїть по центру кадру (left = (кадр − блок) / 2), рядки центруються всередині. Поява,
 * зникнення тексту й зняття вуалі рахує код сторінки (review-assets) за data.title.
 */
export function renderTitleBase(c: TitleCard): string {
  return `<div class="tc-base" id="anim-tcbase" style="background:${esc(c.background.paper)}"></div>`;
}

export function renderTitleCard(c: TitleCard): string {
  const cq = (px: number): string => `${r3((px / c.frameWidth) * 100)}cqw`;
  const pct = (px: number): string => `${r3((px / c.frameHeight) * 100)}%`;
  const bg = c.background;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='${bg.grain}'/></svg>`;
  const grainUrl = `url("data:image/svg+xml,${svg.replace(/</g, '%3C').replace(/>/g, '%3E')}")`;
  const vignette = `radial-gradient(ellipse at center, rgba(60, 40, 20, 0) 55%, rgba(60, 40, 20, ${bg.vignette}) 100%)`;
  const groupTop = Math.min(...c.elements.map((e) => e.topPx));
  const groupBottom = Math.max(...c.elements.map((e) => (e.kind === 'rule' ? e.topPx + e.size : e.topPx + e.lines.length * e.size * e.lineHeight)));
  const cy = (groupTop + groupBottom) / 2;
  const g = bg.glow;
  const solid = r3(Math.max(0, 1 - g.feather / (Math.min(g.width, g.height) / 2)) * 100);
  const glow = g.width > 0
    ? `<div class="tc-glow" id="anim-tcglow" style="left:${cq((c.frameWidth - g.width) / 2)};top:${pct(cy - g.height / 2)};width:${cq(g.width)};height:${cq(g.height)};background:radial-gradient(closest-side, ${rgba(bg.paper, g.alpha)} ${solid}%, ${rgba(bg.paper, 0)} 100%)"></div>`
    : '';
  const shadow = c.textShadow ? `text-shadow:0 0 ${cq(c.textShadow.blur)} ${rgba(c.textShadow.color, c.textShadow.alpha)};` : '';
  const els = c.elements
    .map((e, i) => {
      if (e.kind === 'rule') {
        return `<div class="tc-el tc-rule" data-tc="${i}" style="top:${pct(e.topPx)};left:${cq((c.frameWidth - e.width) / 2)};width:${cq(e.width)};height:${cq(e.size)};background:${esc(e.color)}"></div>`;
      }
      // letter-spacing додає проміжок і після останньої літери: padding-left на ту саму величину вирівнює рядок по центру.
      const pad = e.letterSpacing > 0 ? `padding-left:${e.letterSpacing}em;` : '';
      const st = `top:${pct(e.topPx)};left:${cq((c.frameWidth - c.blockWidth) / 2)};width:${cq(c.blockWidth)};font-size:${cq(e.size)};font-weight:${e.weight};line-height:${e.lineHeight};color:${rgba(e.color, e.alpha)};letter-spacing:${e.letterSpacing}em;${shadow}`;
      return `<div class="tc-el tc-text" data-tc="${i}" style="${esc(st)}">${e.lines.map((l) => `<span class="tc-line" style="${esc(pad)}">${esc(l)}</span>`).join('')}</div>`;
    })
    .join('');
  return `<div class="title-card" id="anim-title" style="font-family:${esc(c.fontStack)}"><div class="tc-veil" id="anim-tcveil" style="background:${esc(bg.paper)}"></div>${glow}<div class="tc-paper" style="${esc(`background-image:${vignette},${grainUrl}`)}"></div>${els}</div>`;
}

export function renderAnimatic(o: { timings?: TimingsFile; audioSrc?: string; items: AnimaticItem[]; word: string; intro: string; title?: TitleCard; offset?: number }): string {
  if (!o.timings || !o.audioSrc) return `<div class="note">Аніматик недоступний: ${o.timings ? 'немає narration.mp3' : 'немає timings.json'} (крок 6).</div>`;
  const t = o.timings;
  // Озвучення стоїть у фільмі із затримкою offset (початковий титр): кадри й слова зсуваються на неї, звук плеєра це зведення.
  const off = o.offset ?? 0;
  const sched = buildSchedule(t.fragments, o.items.map((f) => ({ n: f.n, fragment: f.fragment })), t.duration, t.silent_fragments ?? []);
  const slots = sched.slots.map((s) => ({ ...s, start: r3(s.start + off), end: r3(s.end + off) }));
  const duration = r3(t.duration + off);
  const stageImgs = o.items
    .map((f) => (f.src ? `<img data-frame="${f.n}" src="${esc(f.src)}" alt="${esc(o.word)} ${f.n}">` : `<div class="ph" data-frame="${f.n}">${esc(o.word)} ${f.n} ще не згенеровано</div>`))
    .join('\n');
  const data = {
    duration,
    delay: off,
    title: o.title
      ? {
          duration: o.title.duration,
          release: o.title.release,
          hide: o.title.hide,
          frameWidth: o.title.frameWidth,
          blockWidth: o.title.blockWidth,
          fitStep: o.title.fitStep,
          blur: o.title.background.blur,
          veil: o.title.background.veil,
          glow: o.title.background.glow.alpha,
          saturation: o.title.background.saturation,
          scale: o.title.background.scale,
          fontUrl: o.title.font.url,
          fontChecks: o.title.font.weights.length
            ? o.title.elements.filter((e) => e.kind !== 'rule').map((e) => ({ spec: `${e.weight} ${e.size}px "${o.title!.font.family}"`, text: e.lines.join(' ') }))
            : [],
          elements: o.title.elements.map((e) => ({ kind: e.kind, from: e.from, to: e.to, rise: e.rise, riseCq: r3((e.rise / o.title!.frameWidth) * 100), size: e.size })),
        }
      : null,
    slots,
    fragments: t.fragments.map((f) => ({ n: f.n, start: r3(f.start + off), end: r3(f.end + off), words: f.words.map((w) => [w.text, r3(w.start + off), r3(w.end + off)]) })),
  };
  const notes: string[] = [];
  const silent = t.silent_fragments ?? [];
  if (silent.length) notes.push(`Фрагмент ${silent.join(', ')} без голосу (титр): його ${o.word}ів в аніматику немає, тривалість титру визначить монтажер.`);
  if (sched.fragmentsWithoutFrames.length) notes.push(`Фрагменти без ${o.word}а: ${sched.fragmentsWithoutFrames.join(', ')}. На них лишається попередній.`);
  if (!sched.slots.length) notes.push(`Жоден ${o.word} не прив'язано до фрагмента.`);
  return `
<p class="lead">${esc(o.intro)}</p>
<div class="animatic" id="animatic" tabindex="0">
  <div class="stage">
${o.title ? renderTitleBase(o.title) : ''}
${stageImgs}
${o.title ? renderTitleCard(o.title) : ''}
  </div>
  <div class="sub-meta" id="anim-meta"></div>
  <div class="sub" id="anim-sub"></div>
  <div class="controls">
    <button type="button" id="anim-prev" title="Попередній фрагмент">⏮ Фрагмент</button>
    <button type="button" id="anim-back" title="Назад на 5 секунд">−5 с</button>
    <button type="button" class="primary" id="anim-play">▶ Грати</button>
    <button type="button" id="anim-fwd" title="Вперед на 5 секунд">+5 с</button>
    <button type="button" id="anim-next" title="Наступний фрагмент">Фрагмент ⏭</button>
  </div>
  <div class="seek"><input type="range" id="anim-range" min="0" max="${duration}" step="0.01" value="0" aria-label="Перемотування"><span class="time" id="anim-time">0:00</span></div>
  <div class="ticks" id="anim-ticks" aria-label="Фрагменти"></div>
  <audio id="anim-audio" preload="auto" src="${esc(o.audioSrc)}"></audio>
  ${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
</div>
<script type="application/json" id="review-data">${jsonForScript(data)}</script>`;
}


export function renderVoiceBody(d: { voice?: VoiceEntry; previews: Array<{ n: number; key: string; chosen: boolean }>; rel: (key: string) => string | undefined; timings?: TimingsFile; voiceMd?: VoiceDoc }): string {
  const rel = d.rel;
  let voiceBody = '';
  if (d.voice) {
    voiceBody += `<h3 style="margin-top:0">Голос «${esc(d.voice.id)}»</h3>${d.voice.image ? mdLite(d.voice.image) : ''}<details><summary>Опис для Voice Design</summary><pre>${esc(d.voice.designPrompt)}</pre></details><p class="muted">Текст проби: ${esc(d.voice.probeText)}</p>${d.voice.voiceId ? `<p class="muted">voice_id: <code>${esc(d.voice.voiceId)}</code></p>` : ''}`;
  }
  voiceBody += '<h3>Три проби голосу</h3>';
  voiceBody += d.previews.length
    ? d.previews.map((p) => `<div class="card"><span class="badge">Проба ${p.n}${p.chosen ? ', обрана для озвучення' : ''}</span>${rel(p.key) ? `<audio controls preload="none" src="${esc(rel(p.key)!)}"></audio>` : '<p class="muted">Файл проби недоступний: ElevenLabs його не зберіг.</p>'}</div>`).join('\n')
    : '<div class="note">Проб ще немає (крок 5).</div>';
  voiceBody += '<h3>Повне озвучення</h3>';
  voiceBody += rel('narration') ? `<audio controls preload="none" src="${esc(rel('narration')!)}"></audio>${d.timings ? `<p class="muted">Тривалість ${fmtTime(d.timings.duration)} (${d.timings.duration} с), голос ${esc(d.timings.voice_id)}, модель ${esc(d.timings.model_id)}.</p>` : ''}` : '<div class="note">Озвучення ще немає (крок 6).</div>';
  if (d.voiceMd) {
    voiceBody += `<details><summary>Розмітка озвучення з тегами</summary>${d.voiceMd.fragments.map((f) => `<p><span class="badge">Фрагмент ${f.n}</span> ${esc(f.tagged)}</p>`).join('')}</details>`;
    if (d.voiceMd.pronunciation) voiceBody += `<details><summary>Вимова</summary>${mdLite(d.voiceMd.pronunciation)}</details>`;
  }
  return voiceBody;

}

// Людський підпис ключа з manifest.images. Незнайомий ключ лишається як є.
export function imageLabel(key: string): string {
  if (key.startsWith('sheet/')) return `Аркуш ${key.slice(6)}`;
  if (key.startsWith('sample/')) return `Зразок ${Number(key.slice(7))}`;
  const cur = /^frame\/(\d+)$/.exec(key);
  if (cur) return `Кадр ${Number(cur[1])}`;
  const arch = /^frame-(v\d+)\/(\d+)$/.exec(key);
  if (arch) return `Кадр ${Number(arch[2])}, розкадровка ${arch[1]} (архів)`;
  return key;
}

export function renderCredits(m: Manifest): string {
  const rows: Array<[string, string, string]> = [];
  const v = m.voice as { design_credits?: number } | undefined;
  if (v?.design_credits !== undefined) rows.push(['Проби голосу', '3 проби', String(v.design_credits)]);
  const n = m.narration as { credits?: number; chars_sent?: number } | undefined;
  if (n) rows.push(['Озвучення', `${n.chars_sent ?? '?'} знаків`, String(n.credits ?? '?')]);
  for (const [key, rec] of Object.entries(m.images)) {
    const spent = [rec.current, ...rec.history].reduce((a, x) => a + (x?.credits ?? 0), 0);
    const label = imageLabel(key);
    const cur = rec.current;
    rows.push([label, `перегенерацій: ${rec.regen_count}${cur?.width ? `, ${cur.width}×${cur.height} px (запитано ${cur.resolution})` : ''}`, String(spent)]);
  }
  for (const [key, a] of Object.entries(m.audio)) rows.push([key === 'music' ? 'Музика' : key.startsWith('sample-music-') ? `Зразок музики ${key.slice(13)}` : key.startsWith('sample-sfx-') ? `Зразок шуму ${key.slice(11)}` : `Шум ${key.replace('sfx-', '')}`, `${a.seconds_requested ?? '?'} с`, String((a.credits as number | undefined) ?? '?')]);
  const table = rows.length
    ? `<table><thead><tr><th>Що</th><th>Примітка</th><th class="num">Кредити</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="num">${esc(r[2])}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Платних викликів ще не було.</p>';
  const runs = m.credits.runs.length
    ? `<details><summary>Запуски скриптів (різниця лічильника ElevenLabs до і після)</summary><table><thead><tr><th>Скрипт</th><th>Початок</th><th class="num">До</th><th class="num">Після</th><th class="num">Витрачено</th></tr></thead><tbody>${m.credits.runs.map((r) => `<tr><td>${esc(r.script)}</td><td>${esc(r.started_at.slice(0, 19).replace('T', ' '))}</td><td class="num">${r.credits_before}</td><td class="num">${r.credits_after ?? ''}</td><td class="num">${r.spent_run ?? ''}</td></tr>`).join('')}</tbody></table></details>`
    : '';
  return `<p class="lead">Усього витрачено за історією: <strong>${m.credits.total_spent}</strong> кредитів (за маніфестом).</p>${table}${runs}`;
}
