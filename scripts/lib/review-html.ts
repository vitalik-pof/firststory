// HTML сторінки огляду Етапу 1. Два режими:
//  - artifact: фрагмент для публікації на claude.ai (починається з meta і title, без doctype/html/head/body);
//  - pages: повний самостійний документ для GitHub Pages (підкаталог, лише відносні посилання).

import { buildSchedule } from './animatic';
import type { ReviewData } from './review-build';
import { CLIENT_JS, CSS } from './review-assets';
import type { Role } from './md';

export type ReviewTarget = 'artifact' | 'pages';

export const ROLE_LABEL: Record<Role, string> = {
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

  // ---------------- аніматик
  const frames = d.storyboard?.frames ?? [];
  let animBody: string;
  if (d.timings && rel('narration')) {
    const sched = buildSchedule(d.timings.fragments, frames.map((f) => ({ n: f.n, fragment: f.fragment })), d.timings.duration, d.timings.silent_fragments ?? []);
    const stageImgs = frames
      .map((f) => {
        const src = rel(`frame:${f.n}`);
        return src
          ? `<img data-frame="${f.n}" src="${esc(src)}" alt="Кадр ${f.n}">`
          : `<div class="ph" data-frame="${f.n}">Кадр ${f.n} ще не згенеровано</div>`;
      })
      .join('\n');
    const data = {
      duration: d.timings.duration,
      slots: sched.slots,
      fragments: d.timings.fragments.map((f) => ({ n: f.n, start: f.start, end: f.end, words: f.words.map((w) => [w.text, w.start, w.end]) })),
    };
    const notes: string[] = [];
    const silent = d.timings.silent_fragments ?? [];
    if (silent.length) notes.push(`Фрагмент ${silent.join(', ')} без голосу (титр): його кадрів в аніматику немає, тривалість титру визначить монтажер.`);
    if (sched.fragmentsWithoutFrames.length) notes.push(`Фрагменти без кадру: ${sched.fragmentsWithoutFrames.join(', ')}. На них лишається попередній кадр.`);
    animBody = `
<p class="lead">Чорновий перегляд: кадри розкадровки змінюються під озвучення. Кадр з'являється, коли голос доходить до початку його фрагмента; якщо на фрагмент кілька кадрів, його час ділиться між ними порівну. Звук стартує після натискання «Грати».</p>
<div class="animatic" id="animatic" tabindex="0">
  <div class="stage">
${stageImgs}
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
  <div class="seek"><input type="range" id="anim-range" min="0" max="${d.timings.duration}" step="0.01" value="0" aria-label="Перемотування"><span class="time" id="anim-time">0:00</span></div>
  <div class="ticks" id="anim-ticks" aria-label="Фрагменти"></div>
  <audio id="anim-audio" preload="auto" src="${esc(rel('narration')!)}"></audio>
  ${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
</div>
<script type="application/json" id="review-data">${jsonForScript(data)}</script>`;
  } else {
    animBody = `<div class="note">Аніматик недоступний: ${d.timings ? 'немає narration.mp3' : 'немає timings.json'} (крок 6).</div>`;
  }
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

  // ---------------- голос
  let voiceBody = '';
  if (d.voice) {
    voiceBody += `<h3 style="margin-top:0">Голос «${esc(d.voice.id)}»</h3>${d.voice.image ? mdLite(d.voice.image) : ''}<details><summary>Опис для Voice Design</summary><pre>${esc(d.voice.designPrompt)}</pre></details><p class="muted">Текст проби: ${esc(d.voice.probeText)}</p>${d.voice.voiceId ? `<p class="muted">voice_id: <code>${esc(d.voice.voiceId)}</code></p>` : ''}`;
  }
  voiceBody += '<h3>Три проби голосу</h3>';
  voiceBody += d.previews.length
    ? d.previews.map((p) => `<div class="card"><span class="badge">Проба ${p.n}${p.chosen ? ', обрана для озвучення' : ''}</span>${rel(p.key) ? `<audio controls preload="none" src="${esc(rel(p.key)!)}"></audio>` : ''}</div>`).join('\n')
    : '<div class="note">Проб ще немає (крок 5).</div>';
  voiceBody += '<h3>Повне озвучення</h3>';
  voiceBody += rel('narration') ? `<audio controls preload="none" src="${esc(rel('narration')!)}"></audio>${d.timings ? `<p class="muted">Тривалість ${fmtTime(d.timings.duration)} (${d.timings.duration} с), голос ${esc(d.timings.voice_id)}, модель ${esc(d.timings.model_id)}.</p>` : ''}` : '<div class="note">Озвучення ще немає (крок 6).</div>';
  if (d.voiceMd) {
    voiceBody += `<details><summary>Розмітка озвучення з тегами</summary>${d.voiceMd.fragments.map((f) => `<p><span class="badge">Фрагмент ${f.n}</span> ${esc(f.tagged)}</p>`).join('')}</details>`;
    if (d.voiceMd.pronunciation) voiceBody += `<details><summary>Вимова</summary>${mdLite(d.voiceMd.pronunciation)}</details>`;
  }
  section('voice', 'Голос і озвучення', voiceBody);

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
  if (d.roleDecisions.trim()) section('decisions', 'Рішення ролей замість режисера', mdLite(d.roleDecisions));
  section(
    'questions',
    'Питання ролей до режисера',
    d.questions.length
      ? d.questions.map((q) => `<div class="card"><h3 style="margin-top:0">${esc(ROLE_LABEL[q.role])} <span class="muted">(${esc(q.file)})</span></h3>${mdLite(q.text)}</div>`).join('\n')
      : '<p class="muted">Питань немає.</p>',
  );

  // ---------------- кредити
  section('credits', 'Витрачені кредити', renderCredits(d));

  const warn = d.warnings.length ? `<div class="note"><strong>Чого бракує на цій збірці:</strong><ul>${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  const head = `<h1>${esc(title)}</h1>\n<p class="lead">${esc(d.script.title)}. Сирий матеріал першого прогону: без зведення звуку, монтажу, руху камери й субтитрів.</p>\n<nav class="toc">${nav.map(([id, h]) => `<a href="#${id}">${esc(h)}</a>`).join('')}</nav>\n${warn}`;
  const content = `<div class="page">\n${head}\n${sections.join('\n')}\n</div>\n<script>${CLIENT_JS}</script>`;

  if (target === 'artifact') {
    return `<meta name="claude:viewport-fit-sides" content="cover">\n<title>${esc(title)}</title>\n<style>${CSS}</style>\n${content}\n`;
  }
  return `<!doctype html>\n<html lang="uk">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<link rel="icon" href="data:,">\n<title>${esc(title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n${content}\n</body>\n</html>\n`;
}

function renderCredits(d: ReviewData): string {
  const m = d.manifest;
  const rows: Array<[string, string, string]> = [];
  const v = m.voice as { design_credits?: number } | undefined;
  if (v?.design_credits !== undefined) rows.push(['Проби голосу', '3 проби', String(v.design_credits)]);
  const n = m.narration as { credits?: number; chars_sent?: number } | undefined;
  if (n) rows.push(['Озвучення', `${n.chars_sent ?? '?'} знаків`, String(n.credits ?? '?')]);
  for (const [key, rec] of Object.entries(m.images)) {
    const spent = [rec.current, ...rec.history].reduce((a, x) => a + (x?.credits ?? 0), 0);
    rows.push([key.startsWith('sheet/') ? `Аркуш ${key.slice(6)}` : `Кадр ${Number(key.slice(6))}`, `перегенерацій: ${rec.regen_count}`, String(spent)]);
  }
  for (const [key, a] of Object.entries(m.audio)) rows.push([key === 'music' ? 'Музика' : `Шум ${key.replace('sfx-', '')}`, `${a.seconds_requested ?? '?'} с`, String((a.credits as number | undefined) ?? '?')]);
  const table = rows.length
    ? `<table><thead><tr><th>Що</th><th>Примітка</th><th class="num">Кредити</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="num">${esc(r[2])}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Платних викликів ще не було.</p>';
  const runs = m.credits.runs.length
    ? `<details><summary>Запуски скриптів (різниця лічильника ElevenLabs до і після)</summary><table><thead><tr><th>Скрипт</th><th>Початок</th><th class="num">До</th><th class="num">Після</th><th class="num">Витрачено</th></tr></thead><tbody>${m.credits.runs.map((r) => `<tr><td>${esc(r.script)}</td><td>${esc(r.started_at.slice(0, 19).replace('T', ' '))}</td><td class="num">${r.credits_before}</td><td class="num">${r.credits_after ?? ''}</td><td class="num">${r.spent_run ?? ''}</td></tr>`).join('')}</tbody></table></details>`
    : '';
  return `<p class="lead">Усього витрачено за історією: <strong>${m.credits.total_spent}</strong> кредитів (за маніфестом).</p>${table}${runs}`;
}
