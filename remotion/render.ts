// Рендер проб переходів. Запуск: npx tsx render.ts [--only id,id] [--still N] [--range a-b] [--crf 27] [--out dir] [--index-only]
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProbeProps } from "./src/Root";
import type { ProbeProps } from "./src/types";
import { ALL_VARIANTS, type Variant } from "./src/variants";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const FRAMES_DIR = path.join(repoRoot, "work/01-natalia/frames");
const DEFAULT_OUT = path.join(repoRoot, "work/01-natalia/transitions");
const PUBLIC_DIR = path.join(here, ".cache/public");

const args = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

const only = arg("only")?.split(",") ?? null;
const stillFrame = arg("still");
const range = arg("range");
const crf = Number(arg("crf") ?? 24);
const outDir = path.resolve(arg("out") ?? DEFAULT_OUT);
const browserExecutable =
  process.env.REMOTION_BROWSER_EXECUTABLE ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null);

// Кадри кладемо у public/ бандла: staticFile() на рендері бере їх звідти.
const stageFrames = (): void => {
  rmSync(PUBLIC_DIR, { recursive: true, force: true });
  mkdirSync(path.join(PUBLIC_DIR, "frames"), { recursive: true });
  for (const f of defaultProbeProps.frames) {
    const src = path.join(FRAMES_DIR, path.basename(f));
    if (!existsSync(src)) throw new Error(`Нема кадру ${src}`);
    cpSync(src, path.join(PUBLIC_DIR, f));
  }
};

const propsFor = (v: Variant): ProbeProps => ({
  ...defaultProbeProps,
  frames: defaultProbeProps.frames.slice(0, v.frameCount ?? defaultProbeProps.frames.length),
  transitionFrames: defaultProbeProps.transitionFrames * (v.slow ?? 1),
  transition: v.transition,
});

const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const durationFrames = (v: Variant): number => {
  const p = propsFor(v);
  return p.frames.length * p.holdFrames + (p.frames.length - 1) * p.transitionFrames; // чистий показ кадрів плюс переходи
};

// У бюджет входять три базові акварельні проби й шість повільних. Решта старих файлів лишається в теці, але не рахується.
const BUDGET_IDS = new Set(["wc-blots", "wc-wet", "wc-wet-edge", ...ALL_VARIANTS.filter((v) => v.slow).map((v) => v.id)]);

const writeIndex = (): void => {
  const items = ALL_VARIANTS.flatMap((v) => {
    const file = path.join(outDir, `${v.id}.mp4`);
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    return [
      {
        file: `${v.id}.mp4`,
        title: v.title,
        description: v.description,
        durationSeconds: Number((durationFrames(v) / defaultProbeProps.fps).toFixed(2)),
        transitionSeconds: Number(((defaultProbeProps.transitionFrames * (v.slow ?? 1)) / defaultProbeProps.fps).toFixed(2)),
        sizeBytes: size,
        sizeMB: Number((size / 1e6).toFixed(2)),
        kind: v.transition.kind === "watercolor" ? "custom-watercolor" : "remotion-builtin",
        inBudgetSet: BUDGET_IDS.has(v.id),
      },
    ];
  });
  const sum = (xs: typeof items) => xs.reduce((s, i) => s + i.sizeBytes, 0);
  const budgetSet = items.filter((i) => i.inBudgetSet);
  writeFileSync(
    path.join(outDir, "index.json"),
    JSON.stringify(
      {
        note: "Проби переходів між кадрами 01-04, 540x960, 30 к/с, без звуку. Кадр ~2,5 с, перехід 1,2 с (повільні версії x5 і x10 мають 6 і 12 с). Повільні показують лише склейки 1-2 і 2-3.",
        totalSizeMB: Number((sum(items) / 1e6).toFixed(2)),
        budgetSetSizeMB: Number((sum(budgetSet) / 1e6).toFixed(2)),
        budgetSetNote: "У бюджет 15 МБ входять wc-blots, wc-wet, wc-wet-edge і шість файлів -x5/-x10; решта старих файлів не рахується.",
        variants: items,
      },
      null,
      2,
    ) + "\n",
  );
  log(`index.json: ${items.length} файлів, усього ${(sum(items) / 1e6).toFixed(2)} МБ, у бюджеті ${(sum(budgetSet) / 1e6).toFixed(2)} МБ`);
};

const main = async (): Promise<void> => {
  mkdirSync(outDir, { recursive: true });
  if (args.includes("--index-only")) {
    writeIndex();
    return;
  }
  stageFrames();
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
  };
  const list = ALL_VARIANTS.filter((v) => !only || only.includes(v.id));
  for (const v of list) {
    const inputProps = propsFor(v);
    const composition = await selectComposition({ serveUrl, id: "TransitionProbe", inputProps, ...common });
    if (stillFrame !== null) {
      const out = path.join(outDir, `still-${v.id}-${stillFrame}.png`);
      await renderStill({ composition, serveUrl, inputProps, frame: Number(stillFrame), output: out, imageFormat: "png", ...common });
      log(`кадр ${stillFrame}: ${out}`);
      continue;
    }
    const out = path.join(outDir, `${v.id}.mp4`);
    const frameRange = range ? (range.split("-").map(Number) as [number, number]) : null;
    const started = Date.now();
    let lastLogged = 0;
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      codec: "h264",
      crf,
      x264Preset: "slow",
      pixelFormat: "yuv420p",
      frameRange,
      outputLocation: frameRange ? path.join(outDir, `test-${v.id}.mp4`) : out,
      ...common,
      onProgress: ({ renderedFrames }) => {
        if (Date.now() - lastLogged > 10_000) {
          lastLogged = Date.now();
          log(`${v.id}: ${renderedFrames}/${composition.durationInFrames}`);
        }
      },
    });
    log(`${v.id} готово за ${((Date.now() - started) / 1000).toFixed(0)} с`);
  }
  if (stillFrame === null && !range) writeIndex();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
