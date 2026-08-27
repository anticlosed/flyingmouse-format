const { readSpecialAudio, writeNativeAudio } = require("./audio-format-utils");

const KWM_HEADER_SIZE = 0x400;
const KWM_MAGIC_1 = "yeelion-kuwo-tme";
const KWM_MAGIC_2 = "yeelion-kuwo\x00\x00\x00\x00";
const KWM_PREDEFINED_KEY = "MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk";

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function padOrTruncate(raw, length) {
  if (raw.length === 0) return Buffer.alloc(length);
  const out = Buffer.alloc(length);
  if (raw.length >= length) {
    raw.copy(out, 0, 0, length);
  } else {
    for (let i = 0; i < length; i++) out[i] = raw[i % raw.length];
  }
  return out;
}

function generateMask(key8) {
  const keyInt = key8.readBigUInt64LE();
  const keyStr = keyInt.toString(10);
  const keyBytes = padOrTruncate(Buffer.from(keyStr, "ascii"), 32);
  const mask = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) mask[i] = KWM_PREDEFINED_KEY.charCodeAt(i) ^ keyBytes[i];
  return mask;
}

async function convertKwm(inputPath) {
  const buf = await readSpecialAudio(inputPath);
  if (buf.length < KWM_HEADER_SIZE) throw new Error("KWM 文件不完整。");
  const magic = buf.subarray(0, 0x10).toString("latin1");
  if (magic !== KWM_MAGIC_1 && magic !== KWM_MAGIC_2) throw new Error("不是合法的 KWM 加密音频文件。");
  const key8 = Buffer.from(buf.subarray(0x18, 0x20));
  const mask = generateMask(key8);

  const audio = buf.subarray(KWM_HEADER_SIZE);
  for (let i = 0; i < audio.length; i += 1) audio[i] ^= mask[i & 0x1f];

  const format = detectAudioFormat(audio);
  if (format === "unknown") throw new Error("KWM 解密结果不是可识别的音频格式。");
  return writeNativeAudio(audio, format, "kwm");
}

module.exports = { convertKwm, generateMask, padOrTruncate, detectAudioFormat, KWM_HEADER_SIZE };
