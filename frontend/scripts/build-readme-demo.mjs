import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const output = resolve(repositoryRoot, "docs/assets/note-demo.gif");

// These are real visual-QA captures. The GIF is a short visual tour, not a
// recording of a single interaction sequence.
const captures = [
  "design-qa-evidence/implementation-light-1662x839.png",
  "design-qa-evidence/implementation-selected-light-1662x839.png",
  "design-qa-evidence/implementation-dark-1662x839.png",
].map((capture) => resolve(repositoryRoot, capture));

for (const capture of captures) {
  if (!existsSync(capture)) {
    throw new Error(`Missing visual-QA capture: ${capture}`);
  }
}

mkdirSync(dirname(output), { recursive: true });

const inputs = captures.flatMap((capture) => ["-loop", "1", "-t", "1.5", "-i", capture]);
const frames = captures
  .map(
    (_, index) =>
      `[${index}:v]scale=900:454:force_original_aspect_ratio=decrease,pad=900:454:(ow-iw)/2:(oh-ih)/2,setsar=1[frame${index}]`,
  )
  .join(";");
const frameInputs = captures.map((_, index) => `[frame${index}]`).join("");
const filter = `${frames};${frameInputs}concat=n=${captures.length}:v=1:a=0,fps=8,split[palette_source][gif_source];[palette_source]palettegen=max_colors=128[palette];[gif_source][palette]paletteuse=dither=bayer:bayer_scale=3`;

const result = spawnSync(
  "ffmpeg",
  ["-y", ...inputs, "-filter_complex", filter, "-loop", "0", output],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
