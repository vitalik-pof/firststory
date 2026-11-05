// Огляд зразків (Етап 1а): зміст сторінки і збирання медіа.

import { existsSync, readdirSync } from 'node:fs';
import {
  type CharacterDoc, type SamplesDoc, type SoundSamplesDoc, type VoiceDoc, type VoiceEntry,
  type DirectorQuestions, type RoleDecision, parseRoleDecisions, parseDirectorQuestions, parseProducerDecisions,
  checkSamplesAgainstScript, parseSamples, parseScript, parseSoundSamples, parseStyle, parseVoiceMd, parseVoices, storyAuthorName, type StyleDoc,
} from './docs';
import { type Manifest, readManifest } from './manifest';
import { type Role, blockText, extractQuestions, readDoc, splitByHeading } from './md';
import { paths } from './paths';
import { type MediaItem, type QuestionBlock } from './review-build';
import { type ReviewTarget, decisionSections, esc, fmtTime, mdLite, renderAnimatic, renderCredits, renderVoiceBody, wrapPage } from './review-html';
import { sampleFile } from './samples-paths';
import type { TimingsFile } from './timings';
import { pad2 } from './text';
import { readFileSync } from 'node:fs';

export interface SamplesReviewData {
  story: string;
  name: string;
  scriptTitle: string;
  samples: SamplesDoc;
  sound?: SoundSamplesDoc;
  voice?: VoiceEntry;
  voiceMd?: VoiceDoc;
  style?: StyleDoc;
  characters: CharacterDoc[];
  timings?: TimingsFile;
  manifest: Manifest;
  roleDecisions: RoleDecision[];
  directorQuestions: DirectorQuestions;
  producerDecisions: string[];
  questions: QuestionBlock[];
  warnings: string[];
  media: MediaItem[];
  previews: Array<{ n: number; key: string; chosen: boolean }>;
}

export function gatherSamplesReview(story: string, nameOverride?: string): SamplesReviewData {
  const warnings: string[] = [];
  const script = parseScript(story);
  const samples = parseSamples();
  checkSamplesAgainstScript(samples, script);
  const tryRead = <T,>(what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Error && e.name === 'MissingDocError') {
        warnings.push(`${what}: ${e.message}`);
        return undefined;
      }
      throw e;
    }
  };
  const sound = tryRead('Зразки звуку', () => parseSoundSamples(story));
  const style = tryRead('Стиль', () => parseStyle());
  const voiceMd = tryRead('Розмітка озвучення', () => parseVoiceMd(story));
  const voices = tryRead('Голоси', () => parseVoices());
  const voice = voices?.voices.find((v) => v.id === voiceMd?.voiceId) ?? voices?.voices.find((v) => v.story === story);
  const timingsFile = paths.timings(story);
  const timings = existsSync(timingsFile) ? (JSON.parse(readFileSync(timingsFile, 'utf8')) as TimingsFile) : undefined;
  if (!timings) warnings.push('Немає timings.json: аніматик недоступний (крок 6).');
  const manifest = readManifest(story);

  const questions: QuestionBlock[] = [];
  const addQ = (role: Role, file: string): void => {
    if (!existsSync(file)) return;
    const text = extractQuestions(readDoc(file, role));
    if (text) questions.push({ role, file: paths.rel(file), text });
  };
  addQ('scenarist', paths.storyFile(story, 'script.md'));
  addQ('art-director', paths.styleDoc());
  addQ('art-director', paths.samplesDoc());
  addQ('voice-director', paths.voicesDoc());
  addQ('voice-director', paths.storyFile(story, 'voice.md'));
  addQ('composer', paths.soundSamplesDoc(story));

  const roleDecisions = parseRoleDecisions(story);
  const directorQuestions = parseDirectorQuestions(story);
  const producerDecisions = parseProducerDecisions(story);

  const media: MediaItem[] = [];
  const add = (key: string, kind: MediaItem['kind'], src: string, rel: string): boolean => {
    if (!existsSync(src)) return false;
    media.push({ key, kind, src, rel });
    return true;
  };
  const missing: number[] = [];
  for (const s of samples.samples) if (!add(`sample:${s.n}`, 'image', sampleFile(story, s.n), `media/samples/sample-${pad2(s.n)}.jpg`)) missing.push(s.n);
  if (missing.length) warnings.push(`Немає файлів зразків ${missing.join(', ')} (samples.ts): на їхньому місці заглушки.`);
  const previews: SamplesReviewData['previews'] = [];
  const pdir = paths.workFile(story, 'voice-previews');
  const picked = (manifest.voice?.picked_preview as number | undefined) ?? 1;
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir).filter((x) => /^preview-\d+\.mp3$/.test(x)).sort()) {
      const n = Number(/\d+/.exec(f)![0]);
      add(`preview:${n}`, 'audio', `${pdir}/${f}`, `media/voice/preview-${n}.mp3`);
      previews.push({ n, key: `preview:${n}`, chosen: n === picked });
    }
  }
  if (!previews.length) warnings.push('Немає проб голосу (voice-previews.ts).');
  if (!add('narration', 'audio', paths.workFile(story, 'narration.mp3'), 'media/narration.mp3')) warnings.push('Немає narration.mp3 (narrate.ts).');
  const adir = paths.workFile(story, 'audio', 'samples');
  for (const m of sound?.music ?? []) if (!add(`smusic:${m.n}`, 'audio', `${adir}/music-${m.n}.mp3`, `media/audio/music-${m.n}.mp3`)) warnings.push(`Немає зразка музики ${m.n} (sound-samples.ts).`);
  for (const x of sound?.sfx ?? []) if (!add(`ssfx:${x.n}`, 'audio', `${adir}/sfx-${pad2(x.n)}.mp3`, `media/audio/sfx-${pad2(x.n)}.mp3`)) warnings.push(`Немає зразка шуму ${x.n} (sound-samples.ts).`);
  if (!add('mix', 'audio', paths.workFile(story, 'audio', 'mix-sample.mp3'), 'media/audio/mix-sample.mp3')) warnings.push('Немає зразка зведення (mix-sample.ts).');

  return {
    story, name: nameOverride ?? storyAuthorName(story) ?? story, scriptTitle: script.title, samples, sound, voice, voiceMd, style, characters: [],
    timings, manifest, roleDecisions, directorQuestions, producerDecisions, questions, warnings, media, previews,
  };
}

export function renderSamplesReview(d: SamplesReviewData, target: ReviewTarget, title: string, available: Set<string>): string {
  const rel = (key: string): string | undefined => (available.has(key) ? d.media.find((m) => m.key === key)?.rel : undefined);
  const sections: string[] = [];
  const nav: Array<[string, string]> = [];
  const section = (id: string, heading: string, body: string): void => {
    nav.push([id, heading]);
    sections.push(`<section id="${id}">\n<h2>${esc(heading)}</h2>\n${body}\n</section>`);
  };

  for (const [id, h, body] of decisionSections({ roleDecisions: d.roleDecisions, director: d.directorQuestions, producerDecisions: d.producerDecisions, questions: d.questions }).top) section(id, h, body);

  section(
    'animatic-section',
    'Аніматик на зразках',
    renderAnimatic({
      timings: d.timings,
      narrationSrc: rel('narration'),
      items: d.samples.samples.filter((s) => s.fragment !== undefined).map((s) => ({ n: s.n, fragment: s.fragment!, src: rel(`sample:${s.n}`) })),
      word: 'зразок',
      intro: "Озвучення грає, а зразки стилю змінюються від початку свого фрагмента (поле «Для фрагмента»). Де зразка для фрагмента немає, лишається попередній. Зразки без фрагмента в аніматику не входять. Звук стартує після натискання «Грати».",
    }),
  );

  const cards = d.samples.samples
    .map((s) => {
      const src = rel(`sample:${s.n}`);
      const ratio = s.format.match(/(\d+)\s*[:х×x/]\s*(\d+)/i);
      const ar = ratio ? `${ratio[1]} / ${ratio[2]}` : '9 / 16';
      const t = s.fragment !== undefined ? d.timings?.fragments.find((f) => f.n === s.fragment) : undefined;
      const cur = d.manifest.images[`sample/${pad2(s.n)}`]?.current;
      const res = cur?.resolution ?? s.resolution ?? '1K';
      return `<div class="card" id="sample-${s.n}">
  <p><span class="badge">Зразок ${s.n}</span><span class="badge">${esc(s.format)}</span><span class="badge">запитано ${esc(res)}${cur?.width ? `, вийшло ${cur.width}×${cur.height} px` : ''}</span><span class="badge">${s.fragment !== undefined ? `фрагмент ${s.fragment}${t ? `, ${fmtTime(t.start)}` : ''}` : 'без фрагмента'}</span></p>
  ${src ? `<img src="${esc(src)}" alt="Зразок ${s.n}" loading="lazy" style="max-width:min(100%, ${ar.startsWith('9') ? '360px' : '640px'})">` : `<div class="ph" style="aspect-ratio:${ar}">Зразок ${s.n} ще не згенеровано</div>`}
  <p style="margin-top:10px"><strong>Що показує:</strong> ${esc(s.shows)}</p>
  ${s.heroes.length ? `<p class="muted"><strong>Герої:</strong> ${s.heroes.map((h) => esc(h.id + (h.version ? ` «${h.version}»` : ''))).join(', ')}</p>` : ''}
  <details><summary>Текст для генератора</summary><pre>${esc(s.prompt)}</pre></details>
  ${s.style ? `<details><summary>Власний стиль зразка (замість стандартного)</summary><pre>${esc(s.style)}</pre></details>` : ''}
</div>`;
    })
    .join('\n');
  section('samples', 'Зразки стилю', `${d.samples.idea ? `<p class="lead">${esc(d.samples.idea)}</p>` : ''}${cards}`);

  section('voice', 'Голос і озвучення', renderVoiceBody({ voice: d.voice, previews: d.previews, rel, timings: d.timings, voiceMd: d.voiceMd }));

  let sb = '';
  if (d.sound) {
    const s = d.sound;
    sb += `${s.idea ? `<p class="lead">${esc(s.idea)}</p>` : ''}<h3>Музика</h3>`;
    sb += s.music
      .map((m) => `<div class="card"><span class="badge">Зразок музики ${m.n}</span><span class="badge">${m.seconds} с</span><span class="badge">${m.instrumental ? 'інструментальна' : 'з голосом'}</span>${rel(`smusic:${m.n}`) ? `<audio controls preload="none" src="${esc(rel(`smusic:${m.n}`)!)}"></audio>` : '<div class="note">Файлу ще немає.</div>'}<p><strong>Що показує:</strong> ${esc(m.shows)}</p><details><summary>Текст для генератора</summary><pre>${esc(m.prompt)}</pre></details></div>`)
      .join('\n');
    sb += `<h3>Шуми</h3>${s.sfx.length ? s.sfx.map((x) => `<div class="card"><span class="badge">Шум ${x.n}</span><span class="badge">${x.seconds} с</span>${rel(`ssfx:${x.n}`) ? `<audio controls preload="none" src="${esc(rel(`ssfx:${x.n}`)!)}"></audio>` : '<div class="note">Файлу ще немає.</div>'}<p><strong>Що показує:</strong> ${esc(x.shows)}</p><details><summary>Текст для генератора</summary><pre>${esc(x.prompt)}</pre></details></div>`).join('\n') : '<p class="muted">Зразків шумів немає.</p>'}`;
  } else sb = '<div class="note">sound-samples.md ще немає.</div>';
  section('sound', 'Зразки музики й шумів', sb);

  let mix = '';
  if (d.sound) {
    const z = d.sound.mix;
    const mm = d.manifest.mix_sample as { window?: [number, number]; fragments?: number[]; music_sample?: number } | undefined;
    mix += `${rel('mix') ? `<audio controls preload="none" src="${esc(rel('mix')!)}"></audio>` : '<div class="note">Зразка зведення ще немає (mix-sample.ts).</div>'}`;
    mix += `<p class="muted">Музичний зразок ${z.musicSample}, фрагменти ${z.fragments.join(', ')}${mm?.window ? `, вікно ${fmtTime(mm.window[0])}–${fmtTime(mm.window[1])} озвучення` : ''}. Музика ${z.underDb} дБ відносно голосу там, де говорить голос; ${z.pauseDb} дБ у паузах; зміна гучності ${z.fadeSeconds} с.</p>`;
    if (z.idea) mix += `<h3>Задум зведення</h3>${mdLite(z.idea)}`;
  } else mix = '<div class="note">Параметрів зведення немає: sound-samples.md відсутній.</div>';
  section('mix', 'Зразок зведення', mix);

  for (const [id, h, body] of decisionSections({ roleDecisions: d.roleDecisions, director: d.directorQuestions, producerDecisions: d.producerDecisions, questions: d.questions }).bottom) section(id, h, body);
  section('credits', 'Витрачені кредити', renderCredits(d.manifest));

  return wrapPage(target, title, `${d.scriptTitle}. Етап 1а: зразки стилю й звуку в малому обсязі, без розкадровки (розкадровка це Етап 1б).`, nav, sections, d.warnings);
}
