// CSS і JS сторінки огляду. Без зовнішніх бібліотек. Кольори лише через токени на :root.

const LIGHT = `
  --bg: #f6f4ef;
  --surface: #ffffff;
  --surface-2: #efece4;
  --text: #1f1d1a;
  --muted: #6a655c;
  --border: #d9d4c8;
  --accent: #b5482a;
  --accent-text: #ffffff;
  --warn-bg: #fff3d6;
  --warn-text: #5a4300;
  --stage-bg: #151412;
  --stage-text: #f4f1ea;`;

const DARK = `
  --bg: #161513;
  --surface: #211f1c;
  --surface-2: #2b2824;
  --text: #ece8df;
  --muted: #a49e92;
  --border: #3a3631;
  --accent: #e0805f;
  --accent-text: #1a0f0a;
  --warn-bg: #3a2f10;
  --warn-text: #f2deaa;
  --stage-bg: #0c0b0a;
  --stage-text: #f4f1ea;`;

export const CSS = `
:root {${LIGHT}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK}
  }
}
:root[data-theme="dark"] {${DARK}
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  padding-top: 16px;
  padding-bottom: 56px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.page { max-width: 920px; margin: 0 auto; min-width: 0; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 1.3rem; margin: 40px 0 12px; padding-top: 8px; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
h3 { font-size: 1.05rem; margin: 20px 0 8px; overflow-wrap: anywhere; }
h4 { font-size: 1rem; margin: 14px 0 6px; }
p { margin: 0 0 10px; overflow-wrap: anywhere; }
ul, ol { margin: 0 0 10px; padding-left: 22px; }
li { overflow-wrap: anywhere; }
.lead { color: var(--muted); margin: 0 0 16px; }
nav.toc { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0 8px; }
nav.toc a { color: var(--accent); text-decoration: none; }
nav.toc a:hover { text-decoration: underline; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0; max-width: 100%; }
details { margin: 8px 0; min-width: 0; }
summary { cursor: pointer; color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin: 12px 0; min-width: 0; }
.muted { color: var(--muted); }
.note { background: var(--warn-bg); color: var(--warn-text); border-radius: 8px; padding: 8px 12px; margin: 10px 0; overflow-wrap: anywhere; }
.badge { display: inline-block; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 10px; font-size: 0.82rem; color: var(--muted); margin-right: 6px; }
audio { width: 100%; max-width: 100%; display: block; margin: 6px 0; }
img { max-width: 100%; height: auto; display: block; }
.frame-card { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: 14px; align-items: start; }
.frame-card img, .ph { width: 100%; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); }
.ph { aspect-ratio: 9 / 16; display: flex; align-items: center; justify-content: center; text-align: center; color: var(--muted); padding: 8px; font-size: 0.9rem; }
.frag-text { border-left: 3px solid var(--accent); padding: 2px 0 2px 10px; margin: 0 0 10px; font-size: 1.02rem; }
.sheet img { border-radius: 8px; border: 1px solid var(--border); }
.sheets { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 12px; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; max-width: 100%; }
th, td { border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 0.88rem; }
td.num, th.num { text-align: right; white-space: nowrap; }

/* Аніматик */
.animatic { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin: 12px 0; }
.stage { width: min(100%, 360px, calc(60vh * 9 / 16)); aspect-ratio: 9 / 16; margin: 0 auto 10px; position: relative; background: var(--stage-bg); border-radius: 10px; overflow: hidden; }
.stage img, .stage .ph { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border: 0; border-radius: 0; display: none; }
.stage img.on, .stage .ph.on { display: flex; }
.stage img.on { display: block; }
.stage .ph { color: var(--stage-text); background: var(--stage-bg); }
.sub { text-align: center; min-height: 3.2em; margin: 0 auto 10px; max-width: 520px; overflow-wrap: anywhere; }
.sub .w.now { background: var(--accent); color: var(--accent-text); border-radius: 4px; padding: 0 2px; }
.sub-meta { text-align: center; color: var(--muted); font-size: 0.88rem; margin-bottom: 8px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; margin-bottom: 8px; }
button { font: inherit; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; cursor: pointer; min-height: 40px; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; min-width: 112px; }
button:disabled { opacity: 0.5; cursor: default; }
.seek { display: flex; align-items: center; gap: 10px; min-width: 0; }
.seek input[type=range] { flex: 1 1 auto; min-width: 0; width: 100%; accent-color: var(--accent); }
.seek .time { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.88rem; white-space: nowrap; }
.ticks { position: relative; height: 22px; margin: 2px 0 0; }
.ticks button { position: absolute; top: 0; transform: translateX(-50%); min-height: 0; padding: 0 5px; font-size: 0.72rem; line-height: 20px; height: 22px; border-radius: 6px; }
.ticks button.cur { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }

@media (max-width: 560px) {
  .frame-card { grid-template-columns: minmax(0, 1fr); }
  .frame-card .thumb { max-width: 260px; }
  h1 { font-size: 1.35rem; }
}
`;

/** Код сторінки: плеєр аніматика. Дані — у <script type="application/json" id="review-data">. */
export const CLIENT_JS = `
(function () {
  var el = document.getElementById('review-data');
  if (!el) return;
  var D = JSON.parse(el.textContent);
  var root = document.getElementById('animatic');
  if (!root) return;
  var audio = document.getElementById('anim-audio');
  var playBtn = document.getElementById('anim-play');
  var range = document.getElementById('anim-range');
  var timeEl = document.getElementById('anim-time');
  var subEl = document.getElementById('anim-sub');
  var metaEl = document.getElementById('anim-meta');
  var ticksEl = document.getElementById('anim-ticks');
  var stageImgs = {};
  Array.prototype.forEach.call(root.querySelectorAll('[data-frame]'), function (n) { stageImgs[n.getAttribute('data-frame')] = n; });
  var duration = D.duration || 0;
  var EPS = 0.03; // currentTime у браузері округлюється: seek до 32.471 дає 32.470999
  var curSlot = -1, curFrag = -1, curWord = -1, raf = 0;

  function fmt(t) { t = Math.max(0, t); var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  function dur() { return (audio && isFinite(audio.duration) && audio.duration > 0) ? audio.duration : duration; }
  function slotIndex(t) {
    var S = D.slots; if (!S.length) return -1;
    var lo = 0, hi = S.length - 1, ans = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (S[mid].start <= t + EPS) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function fragIndex(t) {
    var F = D.fragments, ans = 0;
    for (var i = 0; i < F.length; i++) { if (F[i].start <= t + EPS) ans = i; else break; }
    return ans;
  }
  function renderFrag(i) {
    var f = D.fragments[i]; if (!f) return;
    subEl.textContent = '';
    f.words.forEach(function (w, k) {
      var s = document.createElement('span'); s.className = 'w'; s.textContent = w[0]; s.setAttribute('data-k', k);
      subEl.appendChild(s); subEl.appendChild(document.createTextNode(' '));
    });
    metaEl.textContent = 'Фрагмент ' + f.n + ' з ' + D.fragments.length;
    var ts = ticksEl ? ticksEl.querySelectorAll('button') : [];
    Array.prototype.forEach.call(ts, function (b, k) { b.className = k === i ? 'cur' : ''; });
  }
  function render(t) {
    var si = slotIndex(t);
    if (si !== curSlot) {
      curSlot = si;
      var fr = si >= 0 ? String(D.slots[si].frame) : null;
      Object.keys(stageImgs).forEach(function (k) { stageImgs[k].classList.toggle('on', k === fr); });
    }
    var fi = fragIndex(t);
    if (fi !== curFrag) { curFrag = fi; curWord = -1; renderFrag(fi); }
    var f = D.fragments[fi];
    if (f) {
      var wi = -1;
      for (var k = 0; k < f.words.length; k++) { if (f.words[k][1] <= t) wi = k; else break; }
      if (wi !== curWord) {
        curWord = wi;
        Array.prototype.forEach.call(subEl.querySelectorAll('.w'), function (n, k2) { n.classList.toggle('now', k2 === wi); });
      }
    }
    var d = dur();
    if (document.activeElement !== range) range.value = String(t);
    timeEl.textContent = fmt(t) + ' / ' + fmt(d);
  }
  function tick() { render(audio.currentTime); if (!audio.paused) raf = requestAnimationFrame(tick); }
  function seek(t) { t = Math.min(Math.max(0, t), dur()); audio.currentTime = t; render(t); }
  function setPlayLabel() { playBtn.textContent = audio.paused ? '▶ Грати' : '⏸ Пауза'; }

  range.max = String(duration || 1); range.step = '0.01';
  D.fragments.forEach(function (f) {
    if (!ticksEl || !duration) return;
    var b = document.createElement('button'); b.type = 'button'; b.textContent = String(f.n);
    b.title = 'Фрагмент ' + f.n + ' (' + fmt(f.start) + ')';
    b.style.left = (100 * f.start / duration) + '%';
    b.addEventListener('click', function () { seek(f.start); });
    ticksEl.appendChild(b);
  });

  playBtn.addEventListener('click', function () {
    if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); } else audio.pause();
  });
  audio.addEventListener('play', function () { setPlayLabel(); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  audio.addEventListener('pause', function () { setPlayLabel(); render(audio.currentTime); });
  audio.addEventListener('ended', function () { setPlayLabel(); render(audio.currentTime); });
  audio.addEventListener('timeupdate', function () { if (audio.paused) render(audio.currentTime); });
  audio.addEventListener('seeked', function () { render(audio.currentTime); });
  audio.addEventListener('loadedmetadata', function () { range.max = String(dur()); render(audio.currentTime); });
  range.addEventListener('input', function () { seek(parseFloat(range.value)); });
  document.getElementById('anim-back').addEventListener('click', function () { seek(audio.currentTime - 5); });
  document.getElementById('anim-fwd').addEventListener('click', function () { seek(audio.currentTime + 5); });
  document.getElementById('anim-prev').addEventListener('click', function () {
    var i = fragIndex(audio.currentTime), f = D.fragments[i];
    if (f && audio.currentTime - f.start > 1.5) seek(f.start); else if (D.fragments[i - 1]) seek(D.fragments[i - 1].start); else seek(0);
  });
  document.getElementById('anim-next').addEventListener('click', function () {
    var i = fragIndex(audio.currentTime); if (D.fragments[i + 1]) seek(D.fragments[i + 1].start);
  });
  root.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'AUDIO') return;
    if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(audio.currentTime - 5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(audio.currentTime + 5); }
  });
  setPlayLabel();
  render(0);
  window.__animatic = { seek: seek, render: render };
})();
`;
