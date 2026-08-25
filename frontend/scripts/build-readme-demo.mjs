import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const output = resolve(repositoryRoot, "docs/assets/note-demo.gif");
const captureTest = "tests/e2e/readme-demo.spec.ts";
const framesDirectory = resolve(repositoryRoot, "docs/assets/demo-frames");
const frontendRoot = resolve(repositoryRoot, "frontend");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// The capture test records the authoring steps; a verified visual-QA capture
// closes the GIF with a completed bound connector.
const captures = [
  "01-note-page.png",
  "02-textbox.png",
  "03-drawn-shapes.png",
].map((capture) => resolve(framesDirectory, capture));
captures.push(resolve(repositoryRoot, "design-qa-evidence/implementation-bound-arrow-dark-1069x598.png"));

rmSync(framesDirectory, { force: true, recursive: true });
mkdirSync(framesDirectory, { recursive: true });

const capture = spawnSync(
  npm,
  ["exec", "--", "playwright", "test", captureTest, "--project=chromium"],
  { cwd: frontendRoot, stdio: "inherit" },
);

if (capture.error) throw capture.error;
if (capture.status !== 0) process.exit(capture.status ?? 1);

for (const capture of captures) {
  if (!existsSync(capture)) {
    throw new Error(`Missing visual-QA capture: ${capture}`);
  }
}

mkdirSync(dirname(output), { recursive: true });

const inputs = captures.flatMap((capture) => ["-loop", "1", "-t", "1.8", "-i", capture]);
const frames = captures
  .map(
    (_, index) =>
      `[${index}:v]scale=900:454:force_original_aspect_ratio=decrease,pad=900:454:(ow-iw)/2:(oh-ih)/2,setsar=1[frame${index}]`,
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
