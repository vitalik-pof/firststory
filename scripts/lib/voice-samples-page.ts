// Сторінка проб голосів для публікації як приватного Artifact: повний самостійний HTML, файли
// поруч (відносні шляхи), без зовнішніх скриптів і шрифтів, кольори токенами в :root,
// темна тема за системою і за data-theme.

import { esc } from './review-html';

export interface PageVoice {
  name: string;
  note: string;
  current: boolean;
  /** Відносні шляхи до аудіо. */
  alignedSrc: string;
  rawSrc: string;
  f0Before: number | null;
  f0After: number | null;
  paceBefore: number;
  paceAfter: number;
  /** Примітки про обмежений зсув. */
  notes: string[];
}

export interface PageData {
  title: string;
  textPlain: string;
  textTagged: string;
  targetF0: number;
  targetPace: number;
  voices: PageVoice[];
  /** Голоси, яких не вдалося озвучити або ще немає: короткий список причин. */
  skipped: Array<{ name: string; reason: string }>;
}

const LIGHT = `
  --bg: #f6f4ef;
  --surface: #ffffff;
  --surface-2: #efece4;
  --text: #1f1d1a;
  --muted: #6a655c;
  --border: #d9d4c8;
  --accent: #b5482a;
  --warn-bg: #fff3d6;
  --warn-text: #5a4300;`;

const DARK = `
  --bg: #161513;
  --surface: #211f1c;
  --surface-2: #2b2824;
  --text: #ece8df;
  --muted: #a49e92;
  --border: #3a3631;
  --accent: #e0805f;
  --warn-bg: #3a2f10;
  --warn-text: #f2deaa;`;

const CSS = `
:root {${LIGHT}
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK}
  }
}
:root[data-theme="dark"] {${DARK}
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  padding: 16px 16px 48px;
  overflow-x: hidden;
}
.page { max-width: 440px; margin: 0 auto; min-width: 0; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 4px; overflow-wrap: anywhere; }
p { margin: 0 0 10px; overflow-wrap: anywhere; }
.lead { color: var(--muted); font-size: 0.9rem; margin: 0 0 16px; }
.text { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin: 0 0 16px; }
.text p { margin: 0; white-space: pre-line; }
details { margin-top: 10px; }
summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; }
details p { margin-top: 8px; font-size: 0.9rem; color: var(--muted); white-space: pre-line; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin: 0 0 12px; min-width: 0; }
.card.current { border-color: var(--accent); }
.card h2 { font-size: 1.05rem; line-height: 1.3; margin: 0 0 2px; overflow-wrap: anywhere; }
.badge { display: inline-block; font-size: 0.75rem; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 0 8px; margin-left: 6px; vertical-align: middle; }
.note { color: var(--muted); font-size: 0.85rem; margin: 0 0 8px; }
audio { display: block; width: 100%; max-width: 100%; }
.raw { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-width: 0; }
.raw span { flex: none; color: var(--muted); font-size: 0.8rem; }
.raw audio { height: 32px; flex: 1 1 auto; min-width: 0; }
.nums { color: var(--muted); font-size: 0.85rem; margin: 8px 0 0; }
.warn { background: var(--warn-bg); color: var(--warn-text); border-radius: 8px; padding: 6px 10px; font-size: 0.85rem; margin: 8px 0 0; }
`;

const JS = `
(function () {
  var players = document.querySelectorAll('audio');
  players.forEach(function (a) {
    a.addEventListener('play', function () {
      players.forEach(function (b) { if (b !== a) b.pause(); });
    });
  });
})();
`;

/** Число з комою: 14,8. */
export function num(v: number, digits = 1): string {
  return v.toFixed(digits).replace('.', ',');
}

function hz(v: number | null): string {
  return v === null ? '?' : String(Math.round(v));
}

export function renderVoiceCard(v: PageVoice): string {
  const badge = v.current ? '<span class="badge">наш нинішній</span>' : '';
  const note = v.note && !(v.current && /^наш нинішній/i.test(v.note)) ? `<p class="note">${esc(v.note)}</p>` : '';
  const warn = v.notes.length ? `<div class="warn">Зсув обмежено: ${esc(v.notes.join('; '))}.</div>` : '';
  return `<section class="card${v.current ? ' current' : ''}">
<h2>${esc(v.name)}${badge}</h2>
${note}<audio controls preload="none" src="${esc(v.alignedSrc)}"></audio>
<div class="raw"><span>сира</span><audio controls preload="none" src="${esc(v.rawSrc)}"></audio></div>
<p class="nums">висота ${hz(v.f0Before)} → ${hz(v.f0After)} Гц, темп ${num(v.paceBefore)} → ${num(v.paceAfter)} зн/с</p>
${warn}</section>`;
}

/** Заголовок сторінки: 2–4 слова. Беремо з файлу режисера, якщо підходить, інакше типовий. */
export function pageTitle(fileTitle: string): string {
  const words = fileTitle.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 4 ? words.join(' ') : 'Проби голосів v4';
}

export function renderPage(d: PageData): string {
  const skipped = d.skipped.length
    ? `<div class="warn">Без проби: ${d.skipped.map((s) => `${esc(s.name)} (${esc(s.reason)})`).join('; ')}.</div>`
    : '';
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>${esc(d.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<h1>${esc(d.title)}</h1>
<p class="lead">Проби вирівняно до нашого голосу: висота ${hz(d.targetF0)} Гц, темп ${num(d.targetPace)} зн/с, тембр не змінено.</p>
<div class="text">
<p>${esc(d.textPlain)}</p>
<details><summary>З тегами</summary><p>${esc(d.textTagged)}</p></details>
</div>
${d.voices.map(renderVoiceCard).join('\n')}
${skipped}
</div>
<script>${JS}</script>
</body>
</html>
`;
}
