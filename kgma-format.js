const crypto = require("crypto");
const { readSpecialAudio, writeNativeAudio } = require("./audio-format-utils");

const KGM_HEADER = Buffer.from([
  0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b,
  0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14
]);
const KGM_V3_SLOT2_KEY = Buffer.from([0x6c, 0x2c, 0x2f, 0x27]);
const KGM_V3_FILE_BOX_SUFFIX = 0x6b;

function kugoMd5(buffer) {
  const digest = crypto.createHash("md5").update(buffer).digest();
  const ret = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 2) {
    ret[i] = digest[14 - i];
    ret[i + 1] = digest[15 - i];
  }
  return ret;
}

function xorCollapseU32(i) {
  return (i & 0xff) ^ ((i >> 8) & 0xff) ^ ((i >> 16) & 0xff) ^ ((i >> 24) & 0xff);
}

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

async function convertKgma(inputPath) {
  const buf = await readSpecialAudio(inputPath);
  if (buf.length < 0x3c) throw new Error("KGMA 文件不完整。");
  if (!buf.subarray(0, 16).equals(KGM_HEADER)) throw new Error("不是合法的 KGM/KGMA 加密音频文件。");
  const audioOffset = buf.readUInt32LE(0x10);
  const cryptoVersion = buf.readUInt32LE(0x14);
  const cryptoSlot = buf.readUInt32LE(0x18);
  if (cryptoVersion !== 3) throw new Error(`暂不支持这个 KGM 版本（version=${cryptoVersion}，仅支持 KGMA/v3）。`);
  if (cryptoSlot !== 1) throw new Error(`不支持的加密槽位（slot=${cryptoSlot}，仅支持 1）。`);
  if (audioOffset < 0x3c || audioOffset > buf.length) throw new Error("KGMA 音频偏移无效。");
  const cryptoKey = buf.subarray(0x2c, 0x3c);

  const slotBox = kugoMd5(KGM_V3_SLOT2_KEY);
  const fileBox = Buffer.concat([kugoMd5(cryptoKey), Buffer.from([KGM_V3_FILE_BOX_SUFFIX])]);
  const audio = buf.subarray(audioOffset);
  for (let i = 0; i < audio.length; i += 1) {
    let b = audio[i];
    b ^= fileBox[i % 17];
    b ^= (b << 4) & 0xff;
    b ^= slotBox[i % 16];
    b ^= xorCollapseU32(i);
    audio[i] = b;
  }

  const format = detectAudioFormat(audio);
  if (format === "unknown") throw new Error("KGMA 解密结果不是可识别的音频格式。");
  return writeNativeAudio(audio, format, "kgma");
}

module.exports = { convertKgma, kugoMd5, xorCollapseU32, detectAudioFormat };
