const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const MAX_SPECIAL_AUDIO_BYTES = 512 * 1024 * 1024;

async function readSpecialAudio(inputPath) {
  const stat = await fsp.stat(inputPath);
  if (!stat.isFile()) throw new Error("音频源文件无效。");
  if (stat.size > MAX_SPECIAL_AUDIO_BYTES) {
    const error = new Error("加密音频文件超过 512 MB 限制。");
    error.code = "AUDIO_FILE_TOO_LARGE";
    throw error;
  }
  return fsp.readFile(inputPath);
}

async function writeNativeAudio(audio, format, prefix) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `flyingmouse-${prefix}-`));
  try {
    const nativePath = path.join(tempDir, `native.${format}`);
    await fsp.writeFile(nativePath, audio);
    return { nativePath, format, tempDir };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { readSpecialAudio, writeNativeAudio, MAX_SPECIAL_AUDIO_BYTES };
