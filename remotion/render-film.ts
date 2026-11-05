// Рендер повного фільму 01-natalia (композиція Film). Пропси щоразу будуються з edit.md і timings.json.
//
//   npx tsx render-film.ts --still 0,100,300     # стоп-кадри в work/01-natalia/film-stills/still-N.png
//   npx tsx render-film.ts --test                # тестовий шматок, кадри 0–711 → work/01-natalia/film-test.mp4
//   npx tsx render-film.ts --full                # весь фільм → work/01-natalia/film.mp4 (довго, запускай у фоні)
//
// Додатково: --story <id>, --range a-b (свій шматок → film-range-a-b.mp4), --crf N (18 за замовчуванням),
// --concurrency N, --props-only (лише записати work/<id>/film-props.json).
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFilmProps, readBumps } from "../scripts/lib/film-props";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const story = arg("story") ?? "01-natalia";
const workDir = path.join(repoRoot, "work", story);
const PUBLIC_DIR = path.join(here, ".cache/film-public");
const TEST_RANGE: [number, number] = [0, 711];
const crf = Number(arg("crf") ?? 18);
const concurrency = arg("concurrency") ? Number(arg("concurrency")) : null;
const browserExecutable =
  process.env.REMOTION_BROWSER_EXECUTABLE ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null);

const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const main = async (): Promise<void> => {
  const modes = [arg("still") !== null, flag("test"), flag("full"), arg("range") !== null, flag("props-only")].filter(Boolean).length;
  if (modes !== 1) throw new Error("Потрібен рівно один режим: --still N[,N], --test, --full, --range a-b або --props-only.");

  const { props, warnings } = buildFilmProps({ story, bumps: readBumps(story) });
  for (const w of warnings) log(`УВАГА: ${w}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "film-props.json"), JSON.stringify(props, null, 1) + "\n");
  if (flag("props-only")) return;

  // Кадри (поточні версії, без .vN) і зведення кладемо в public/ бандла: staticFile() на рендері бере їх звідти.
  rmSync(PUBLIC_DIR, { recursive: true, force: true });
  mkdirSync(path.join(PUBLIC_DIR, "frames"), { recursive: true });
  for (const s of props.shots) {
    const src = path.join(workDir, "frames", path.basename(s.src));
    if (!existsSync(src)) throw new Error(`Нема кадру ${src}`);
    cpSync(src, path.join(PUBLIC_DIR, s.src));
  }
  if (props.audio) cpSync(path.join(workDir, props.audio), path.join(PUBLIC_DIR, props.audio));
  else if (!arg("still")) throw new Error(`Нема ${path.join(workDir, "mix.mp3")}: без звуку фільм не рендерю (збери його: npx tsx scripts/mix-full.ts --story ${story}).`);

  log("збираю бандл");
  const serveUrl = await bundle({
    entryPoint: path.join(here, "src/index.ts"),
    publicDir: PUBLIC_DIR,
    onProgress: (p) => {
      if (p % 25 === 0) log(`бандл ${p}%`);
    },
  });
  const common = {
    browserExecutable,
    chromeMode: "chrome-for-testing" as const,
    chromiumOptions: { gl: (process.env.REMOTION_GL ?? "swangle") as "swangle", disableWebSecurity: false },
    logLevel: "warn" as const,
    timeoutInMilliseconds: 180_000,
  };
  const composition = await selectComposition({ serveUrl, id: "Film", inputProps: props, ...common });
  if (composition.durationInFrames !== props.durationInFrames) throw new Error(`Композиція має ${composition.durationInFrames} кадрів, пропси ${props.durationInFrames}.`);

  const stills = arg("still");
  if (stills !== null) {
    const dir = path.join(workDir, "film-stills");
    mkdirSync(dir, { recursive: true });
    for (const f of stills.split(",").map(Number)) {
      const out = path.join(dir, `still-${String(f).padStart(4, "0")}.png`);
      const t0 = Date.now();
      await renderStill({ composition, serveUrl, inputProps: props, frame: f, output: out, imageFormat: "png", ...common });
      log(`кадр ${f}: ${out} (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
    }
    return;
  }

  const rangeArg = arg("range");
  const frameRange: [number, number] | null = flag("test") ? TEST_RANGE : flag("full") ? null : (rangeArg!.split("-").map(Number) as [number, number]);
  const out = path.join(workDir, flag("full") ? "film.mp4" : flag("test") ? "film-test.mp4" : `film-range-${frameRange![0]}-${frameRange![1]}.mp4`);
  const started = Date.now();
  let lastLogged = 0;
  const total = frameRange ? frameRange[1] - frameRange[0] + 1 : composition.durationInFrames;
  await renderMedia({
    composition,
    serveUrl,
    inputProps: props,
    codec: "h264",
    audioCodec: "aac",
    crf,
    x264Preset: "medium",
    pixelFormat: "yuv420p",
    frameRange,
    outputLocation: out,
    concurrency,
    ...common,
    onProgress: ({ renderedFrames }) => {
      if (Date.now() - lastLogged > 15_000) {
        lastLogged = Date.now();
        const el = (Date.now() - started) / 1000;
        log(`${renderedFrames}/${total} кадрів, ${el.toFixed(0)} с, залишилось ~${renderedFrames ? ((el / renderedFrames) * (total - renderedFrames)).toFixed(0) : "?"} с`);
      }
    },
  });
  log(`готово за ${((Date.now() - started) / 1000).toFixed(0)} с: ${out} (${(statSync(out).size / 1e6).toFixed(1)} МБ)`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
