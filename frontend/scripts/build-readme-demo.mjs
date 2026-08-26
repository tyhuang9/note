import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const output = resolve(repositoryRoot, "docs/assets/note-demo.gif");
const staticOutput = resolve(repositoryRoot, "docs/assets/note-demo-static.png");
const captureTest = "tests/e2e/readme-demo.spec.ts";
const framesDirectory = resolve(repositoryRoot, "docs/assets/demo-frames");
const frontendRoot = resolve(repositoryRoot, "frontend");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const playwrightCli = resolve(frontendRoot, "node_modules/@playwright/test/cli.js");

const captures = [
  "01-ready-to-draw.png",
  "02-head-01.png",
  "03-head-02.png",
  "04-head-03.png",
  "05-head-04.png",
  "06-head-05.png",
  "07-head-06.png",
  "08-head-07.png",
  "09-left-eye-01.png",
  "10-left-eye-02.png",
  "11-left-eye-03.png",
  "12-right-eye-01.png",
  "13-right-eye-02.png",
  "14-right-eye-03.png",
  "15-left-pupil.png",
  "16-right-pupil.png",
  "17-mouth-01.png",
  "18-mouth-02.png",
].map((capture) => [capture, 0.16]).concat([
  ["19-finished-face.png", 1.5],
]).map(([capture, duration]) => ({
  path: resolve(framesDirectory, capture),
  duration,
}));

rmSync(framesDirectory, { force: true, recursive: true });
mkdirSync(framesDirectory, { recursive: true });

const capture = spawnSync(
  process.execPath,
  [playwrightCli, "test", captureTest, "--project=chromium"],
  {
    cwd: frontendRoot,
    env: { ...process.env, PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT ?? "4181" },
    stdio: "inherit",
  },
);

if (capture.error) throw capture.error;
if (capture.status !== 0) process.exit(capture.status ?? 1);

for (const capture of captures) {
  if (!existsSync(capture.path)) {
    throw new Error(`Missing README demo capture: ${capture.path}`);
  }
}

mkdirSync(dirname(output), { recursive: true });

const inputs = captures.flatMap(({ path, duration }) => ["-loop", "1", "-t", String(duration), "-i", path]);
const frames = captures
  .map(
    (_, index) =>
      `[${index}:v]scale=900:454:force_original_aspect_ratio=decrease,pad=900:454:(ow-iw)/2:(oh-ih)/2:color=0xFAF8F4,setsar=1[frame${index}]`,
  )
  .join(";");
const frameInputs = captures.map((_, index) => `[frame${index}]`).join("");
const filter = `${frames};${frameInputs}concat=n=${captures.length}:v=1:a=0,fps=8,split[palette_source][gif_source];[palette_source]palettegen=max_colors=128[palette];[gif_source][palette]paletteuse=dither=bayer:bayer_scale=3`;

const result = spawnSync(
  ffmpeg,
  ["-y", ...inputs, "-filter_complex", filter, "-loop", "0", output],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const staticResult = spawnSync(
  ffmpeg,
  [
    "-y",
    "-i",
    captures.at(-1).path,
    "-vf",
    "scale=900:454:force_original_aspect_ratio=decrease,pad=900:454:(ow-iw)/2:(oh-ih)/2:color=0xFAF8F4",
    "-frames:v",
    "1",
    "-update",
    "1",
    staticOutput,
  ],
  { stdio: "inherit" },
);

if (staticResult.error) throw staticResult.error;
if (staticResult.status !== 0) process.exit(staticResult.status ?? 1);
