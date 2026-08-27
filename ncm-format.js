const crypto = require("crypto");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { normalizeNcmMetadata } = require("./ncm-metadata");
const { readSpecialAudio } = require("./audio-format-utils");

const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex");
const META_KEY = Buffer.from("2331346C6A6B5F215C5D2630553C2728", "hex");
const NCM_MAGIC = "CTENFDAM";
const MAX_NCM_COVER_BYTES = 16 * 1024 * 1024;
const MAX_NCM_COVER_PIXELS = 50 * 1000 * 1000;
const MAX_NCM_COVER_DIMENSION = 16384;

function aesEcbDecrypt(data, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function ncmKeyStream(rc4key) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + rc4key[i % rc4key.length]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const k = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    const a = (i + 1) & 255;
    const b = s[(a + s[a]) & 255];
    k[i] = s[(s[a] + b) & 255];
  }
  return k;
}

function ncmDecryptInPlace(rc4key, out) {
  const k = ncmKeyStream(rc4key);
  for (let i = 0; i < out.length; i += 1) out[i] ^= k[i & 255];
}

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 11 && buf.subarray(4, 8).toString("latin1") === "ftyp") return "m4a";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function pngChunkCrc(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isCompletePng(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 45 || !buf.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let first = true;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataEnd = typeStart + 4 + length;
    const chunkEnd = dataEnd + 4;
    if (length > buf.length || chunkEnd > buf.length) return false;
    const type = buf.subarray(typeStart, typeStart + 4).toString("ascii");
    if (first && (type !== "IHDR" || length !== 13)) return false;
    if (pngChunkCrc(buf.subarray(typeStart, dataEnd)) !== buf.readUInt32BE(dataEnd)) return false;
    offset = chunkEnd;
    first = false;
    if (type === "IEND") return length === 0 && offset === buf.length;
  }
  return false;
}

function isCompleteJpeg(buf) {
  if (buf.length < 16 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return false;
  let offset = 2;
  let sawFrame = false;
  while (offset < buf.length - 2) {
    if (buf[offset] !== 0xff) return false;
    while (buf[offset] === 0xff) offset += 1;
    const marker = buf[offset++];
    if (marker === 0xd9) return sawFrame && offset === buf.length;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return false;
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 8 || buf.readUInt16BE(offset + 3) === 0 || buf.readUInt16BE(offset + 5) === 0) return false;
      sawFrame = true;
    }
    if (marker === 0xda) return sawFrame;
    offset += length;
  }
  return false;
}

function coverDimensions(buf, format) {
  if (format === "png") {
    if (buf.length < 24 || buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset < buf.length - 2) {
    if (buf[offset] !== 0xff) return null;
    while (buf[offset] === 0xff) offset += 1;
    const marker = buf[offset++];
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return null;
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) return null;
    const isFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isFrame) return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
    if (marker === 0xda) return null;
    offset += length;
  }
  return null;
}

function coverWithinLimits(buf, format) {
  const dimensions = coverDimensions(buf, format);
  return Boolean(dimensions
    && dimensions.width > 0
    && dimensions.height > 0
    && dimensions.width <= MAX_NCM_COVER_DIMENSION
    && dimensions.height <= MAX_NCM_COVER_DIMENSION
    && dimensions.width * dimensions.height <= MAX_NCM_COVER_PIXELS);
}

function detectCoverFormat(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (isCompletePng(buf) && coverWithinLimits(buf, "png")) return "png";
  if (isCompleteJpeg(buf) && coverWithinLimits(buf, "jpg")) return "jpg";
  return null;
}

function decodeMeta(metaData) {
  try {
    const xored = Buffer.from(metaData);
    for (let i = 0; i < xored.length; i += 1) xored[i] ^= 0x63;
    const b64 = xored.toString("utf8").replace(/^.{22}/s, "");
    const decrypted = aesEcbDecrypt(Buffer.from(b64, "base64"), META_KEY);
    const padLen = decrypted.length > 0 && decrypted[decrypted.length - 1] >= 1 && decrypted[decrypted.length - 1] <= 16
      ? decrypted[decrypted.length - 1]
      : 0;
    const payloadEnd = decrypted.length - padLen;
    const json = JSON.parse(decrypted.subarray(6, payloadEnd).toString("utf8"));
    return json;
  } catch {
    return null;
  }
}

function tryDecrypt(buf, keyLenOff, keyStart) {
  if (keyLenOff < 0 || keyLenOff + 4 > buf.length || keyStart < 0 || keyStart > buf.length) return null;
  const keyLen = buf.readUInt32LE(keyLenOff);
  if (keyLen <= 0 || keyLen > 8192) return null;
  if (keyStart + keyLen + 4 > buf.length) return null;

  let keyBox;
  try {
    const enc = Buffer.from(buf.subarray(keyStart, keyStart + keyLen));
    for (let i = 0; i < enc.length; i += 1) enc[i] ^= 0x64;
    keyBox = aesEcbDecrypt(enc, CORE_KEY);
  } catch {
    return null;
  }

  const padLen = keyBox.length > 0 && keyBox[keyBox.length - 1] >= 1 && keyBox[keyBox.length - 1] <= 16
    ? keyBox[keyBox.length - 1]
    : 0;
  const payloadEnd = keyBox.length - padLen;
  const rc4key = keyBox.subarray(17, payloadEnd);
  if (rc4key.length < 4) return null;

  const metaOff = keyStart + keyLen;
  if (metaOff + 4 > buf.length) return null;
  const metaLen = buf.readUInt32LE(metaOff);
  if (metaLen <= 0 || metaLen > 1 << 20) return null;
  if (metaOff + 4 + metaLen + 13 > buf.length) return null;

  const meta = decodeMeta(buf.subarray(metaOff + 4, metaOff + 4 + metaLen));
  let audioOff = metaOff + 4 + metaLen + 4 + 5;
  let coverLen = 0;
  if (audioOff + 4 <= buf.length) {
    coverLen = buf.readUInt32LE(audioOff);
    audioOff += 4;
  }
  if (coverLen < 0 || coverLen > MAX_NCM_COVER_BYTES || coverLen > buf.length - audioOff) return null;
  const coverData = coverLen > 0 ? Buffer.from(buf.subarray(audioOff, audioOff + coverLen)) : null;
  const coverFormat = detectCoverFormat(coverData);
  audioOff += coverLen;
  if (audioOff >= buf.length) return null;

  const encryptedAudio = buf.subarray(audioOff);
  const probe = Buffer.from(encryptedAudio.subarray(0, Math.min(12, encryptedAudio.length)));
  ncmDecryptInPlace(rc4key, probe);
  const format = detectAudioFormat(probe);
  if (format === "unknown") return null;
  ncmDecryptInPlace(rc4key, encryptedAudio);
  const audioData = encryptedAudio;
  return { audioData, format, meta, coverData: coverFormat ? coverData : null, coverFormat };
}

async function convertNcm(inputPath) {
  const buf = await readSpecialAudio(inputPath);
  if (buf.subarray(0, 8).toString("latin1") !== NCM_MAGIC) {
    throw new Error("不是有效的网易云 NCM 文件（缺少 CTENFDAM 文件头）。");
  }
  const layouts = [
    [10, 14],
    [9, 13],
    [8, 12],
    [8, 10],
    [10, 12],
    [12, 14],
    [12, 16]
  ];
  for (const [keyLenOff, keyStart] of layouts) {
    const result = tryDecrypt(buf, keyLenOff, keyStart);
    if (result) {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ncm-"));
      try {
        const nativePath = path.join(tempDir, `native.${result.format}`);
        await fsp.writeFile(nativePath, result.audioData);
        let coverPath = null;
        if (result.coverData && result.coverFormat) {
          coverPath = path.join(tempDir, `cover.${result.coverFormat}`);
          await fsp.writeFile(coverPath, result.coverData);
        }
        return {
          nativePath,
          format: result.format,
          tempDir,
          meta: result.meta,
          metadata: normalizeNcmMetadata(result.meta),
          coverPath
        };
      } catch (error) {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }
  }
  throw new Error("NCM 解密失败：文件可能不是官方网易云客户端下载的标准 NCM。");
}

module.exports = { convertNcm, detectAudioFormat, detectCoverFormat };
