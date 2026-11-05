// Стискає готові проби, щоб усі разом вклалися в бюджет. Запуск: npx tsx compress.ts [--budget-mb 13.5] [--dir dir]
// Файли, що вже менші за свою частку бюджету, не чіпає. Решту перекодовує ffmpeg у два проходи.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n: string): string | null => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const dir = path.resolve(arg("dir") ?? path.join(here, "../work/01-natalia/transitions"));
const budget = Number(arg("budget-mb") ?? 13.5) * 1e6;

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".mp4") && !f.startsWith("test-"))
  .sort();
const share = budget / files.length;
const duration = (f: string): number =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

for (const name of files) {
  const file = path.join(dir, name);
  const size = statSync(file).size;
  if (size <= share) {
    console.log(`${name}: ${(size / 1e6).toFixed(2)} МБ, лишаю`);
    continue;
  }
  const kbps = Math.floor(((share * 0.97 * 8) / duration(file)) / 1000);
  const tmp = path.join(dir, `.tmp-${name}`);
  const passlog = path.join(os.tmpdir(), `pass-${name}`);
  const base = ["-y", "-loglevel", "error", "-i", file, "-c:v", "libx264", "-preset", "slow", "-pix_fmt", "yuv420p", "-b:v", `${kbps}k`, "-an", "-passlogfile", passlog];
  console.log(`${name}: ${(size / 1e6).toFixed(2)} МБ -> ціль ${kbps} кбіт/с`);
  execFileSync("ffmpeg", [...base, "-pass", "1", "-f", "mp4", "/dev/null"]);
  execFileSync("ffmpeg", [...base, "-pass", "2", "-movflags", "+faststart", tmp]);
  renameSync(tmp, file);
  for (const ext of ["-0.log", "-0.log.mbtree"]) if (existsSync(passlog + ext)) rmSync(passlog + ext);
  console.log(`  стало ${(statSync(file).size / 1e6).toFixed(2)} МБ`);
}
const total = readdirSync(dir)
  .filter((f) => f.endsWith(".mp4") && !f.startsWith("test-"))
  .reduce((s, f) => s + statSync(path.join(dir, f)).size, 0);
console.log(`разом ${(total / 1e6).toFixed(2)} МБ`);
