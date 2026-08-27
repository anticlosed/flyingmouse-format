const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const childProcess = require("child_process");
const https = require("https");
const { readSpecialAudio, writeNativeAudio } = require("./audio-format-utils");

const { ekeyDecrypt, createQMC2, QMC2MAP, QMC2RC4 } = require("./kgg-format");

const FLAC_HEADER = Buffer.from("fLaC", "latin1");
const OGG_HEADER = Buffer.from("OggS", "latin1");
const MUSICEX_MAGIC = Buffer.from("musicex\x00", "latin1");
const QMC2_ENCV2_PREFIX = "QQMusic EncV2,Key:";
const MIX_KEY1 = Buffer.from([0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28]);
const MIX_KEY2 = Buffer.from([0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54]);
const API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const API_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const API_PLATFORM = "20";
const MUSICEX_HOSTS = new Set([
  "dl.stream.qqmusic.qq.com",
  "isure.stream.qqmusic.qq.com",
  "ws.stream.qqmusic.qq.com"
]);
const MAX_MUSICEX_API_BYTES = 2 * 1024 * 1024;
const MAX_MUSICEX_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_MUSICEX_SIP_COUNT = 4;
const MAX_MUSICEX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_MUSICEX_TOTAL_MS = 5 * 60 * 1000;

let cachedDesktopDir = null;
let desktopDirResolved = false;

function resolveWindowsDesktopDir() {
  if (process.platform !== "win32") return null;
  if (desktopDirResolved) return cachedDesktopDir;
  desktopDirResolved = true;
  try {
    const out = childProcess.execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Desktop')"],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    ).trim();
    if (out && /^[A-Za-z]:[\\/]/.test(out)) cachedDesktopDir = out;
  } catch {
  }
  return cachedDesktopDir;
}

function getDefaultCookiePath() {
  if (process.env.FLYINGMOUSE_QQ_COOKIE) return process.env.FLYINGMOUSE_QQ_COOKIE;
  const fileName = "QQ音乐_登录cookie.txt";
  const home = os.homedir();
  const dirs = [];
  const realDesktop = resolveWindowsDesktopDir();
  if (realDesktop) dirs.push(realDesktop);
  dirs.push(path.join(home, "Desktop"));
  dirs.push(path.join(home, "OneDrive", "Desktop"));
  const seen = new Set();
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(realDesktop || path.join(home, "Desktop"), fileName);
}

function qmcError(message, code = "MFLAC_DECRYPT_FAILED") {
  const error = new Error(message);
  error.code = code;
  error.messages = {
    zhCN: message,
    enUS: code === "MFLAC_EKEY_NETWORK"
      ? "Could not fetch the encryption key from QQ Music API."
      : (code === "MFLAC_EKEY_REQUIRED"
        ? "This file requires your QQ Music login cookie on the Desktop to obtain the key."
        : "MFLAC decryption failed.")
  };
  return error;
}

function readLimitedResponse(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      response.destroy();
      reject(error);
    };
    response.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(new Error("响应内容超过大小限制。"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    response.on("aborted", () => fail(new Error("响应被提前中止。")));
    response.on("close", () => {
      if (!settled) fail(new Error("响应未完整接收。"));
    });
    response.on("error", fail);
  });
}

function requestHttps(url, options = {}) {
  const maxBytes = options.maxBytes || MAX_MUSICEX_API_BYTES;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve(value);
    };
    let request;
    try {
      request = https.request(url, {
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || 30000
      }, (response) => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          response.resume();
          finish(new Error(`HTTP ${status}`));
          return;
        }
        const contentLength = Number(response.headers["content-length"] || 0);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.resume();
          finish(new Error("响应内容超过大小限制。"));
          return;
        }
        readLimitedResponse(response, maxBytes).then(
          (value) => finish(null, value),
          (error) => finish(error)
        );
      });
    } catch (error) {
      finish(error);
      return;
    }
    request.on("timeout", () => {
      const error = new Error("请求超时。");
      request.destroy(error);
      finish(error);
    });
    request.on("error", (error) => finish(error));
    timeoutTimer = setTimeout(() => {
      const error = new Error("请求超时。");
      request.destroy(error);
      finish(error);
    }, options.totalTimeout || options.timeout || 30000);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function timeoutWithinDeadline(deadline, fallback) {
  if (!deadline) return fallback;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw qmcError("QQ 音乐请求超过总时限。", "MFLAC_EKEY_NETWORK");
  return Math.min(fallback, remaining);
}

function resolveMusicexDownloadUrl(base, purl) {
  const url = new URL(purl, new URL(base));
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || !MUSICEX_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("QQ 音乐下载地址不在允许的 CDN 范围内。");
  }
  return url;
}

const TEA_DELTA = 0x9e3779b9;
const QMC2_ENCV2_KEY1 = MIX_KEY1;
const QMC2_ENCV2_KEY2 = MIX_KEY2;

class TeaCipher {
  constructor(key, rounds = 64) {
    if (key.length !== 16) throw new Error("incorrect key size");
    const k = new DataView(key.buffer, key.byteOffset, 16);
    this.k0 = k.getUint32(0, false);
    this.k1 = k.getUint32(4, false);
    this.k2 = k.getUint32(8, false);
    this.k3 = k.getUint32(12, false);
    this.rounds = rounds;
  }
  decrypt(dst, src) {
    let v0 = src.getUint32(0, false);
    let v1 = src.getUint32(4, false);
    let sum = (TEA_DELTA * this.rounds) / 2;
    for (let i = 0; i < this.rounds / 2; i += 1) {
      v1 -= ((v0 << 4) + this.k2) ^ (v0 + sum) ^ ((v0 >>> 5) + this.k3);
      v0 -= ((v1 << 4) + this.k0) ^ (v1 + sum) ^ ((v1 >>> 5) + this.k1);
      sum -= TEA_DELTA;
    }
    dst.setUint32(0, v0, false);
    dst.setUint32(4, v1, false);
  }
}

function decryptTencentTea(inBuf, key) {
  if (inBuf.length % 8 !== 0) throw new Error("inBuf size not a multiple of the block size");
  if (inBuf.length < 16) throw new Error("inBuf size too small");
  const blk = new TeaCipher(key, 32);
  const tmpBuf = new Uint8Array(8);
  const tmpView = new DataView(tmpBuf.buffer);
  blk.decrypt(tmpView, new DataView(inBuf.buffer, inBuf.byteOffset, 8));
  const nPadLen = tmpBuf[0] & 0x7;
  const outLen = inBuf.length - 1 - nPadLen - 2 - 7;
  if (outLen < 0) throw qmcError("MFLAC 密钥填充长度无效。");
  const outBuf = new Uint8Array(outLen);
  let ivPrev = new Uint8Array(8);
  let ivCur = inBuf.slice(0, 8);
  let inBufPos = 8;
  let tmpIdx = 1 + nPadLen;
  const cryptBlock = () => {
    ivPrev = ivCur;
    ivCur = inBuf.slice(inBufPos, inBufPos + 8);
    for (let j = 0; j < 8; j += 1) tmpBuf[j] ^= ivCur[j];
    blk.decrypt(tmpView, tmpView);
    inBufPos += 8;
    tmpIdx = 0;
  };
  for (let i = 1; i <= 2; ) {
    if (tmpIdx < 8) { tmpIdx += 1; i += 1; } else { cryptBlock(); }
  }
  let outBufPos = 0;
  while (outBufPos < outLen) {
    if (tmpIdx < 8) {
      outBuf[outBufPos] = tmpBuf[tmpIdx] ^ ivPrev[tmpIdx];
      outBufPos += 1;
      tmpIdx += 1;
    } else {
      cryptBlock();
    }
  }
  return outBuf;
}

function simpleMakeKey(salt, length) {
  const keyBuf = [];
  for (let i = 0; i < length; i += 1) {
    const tmp = Math.tan(salt + i * 0.1);
    keyBuf[i] = 0xff & (Math.abs(tmp) * 100.0);
  }
  return keyBuf;
}

function parseV1KeyRegion(keyRegion) {
  let decoded;
  try {
    decoded = Buffer.from(keyRegion.toString("utf8"), "base64");
  } catch {
    return { type: "legacy" };
  }
  if (
    decoded.length >= QMC2_ENCV2_PREFIX.length &&
    decoded.subarray(0, QMC2_ENCV2_PREFIX.length).toString("latin1") === QMC2_ENCV2_PREFIX
  ) {
    let out = decryptTencentTea(decoded.subarray(QMC2_ENCV2_PREFIX.length), QMC2_ENCV2_KEY1);
    out = decryptTencentTea(out, QMC2_ENCV2_KEY2);
    const nums = out.toString("utf8").split(",").map((s) => parseInt(s, 10));
    const numBuf = Buffer.from(nums);
    const text = numBuf.toString("latin1");
    const ekey = /^[A-Za-z0-9+/=\r\n]+$/.test(text) ? Buffer.from(text, "base64") : numBuf;
    return { type: "encv2", ekey };
  }
  return { type: "legacy" };
}

function deriveQmcKey(ekeyBinary) {
  const simpleKey = simpleMakeKey(106, 8);
  const teaKey = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    teaKey[i << 1] = simpleKey[i];
    teaKey[(i << 1) + 1] = ekeyBinary[i];
  }
  const sub = decryptTencentTea(ekeyBinary.subarray(8), teaKey);
  return Buffer.concat([ekeyBinary.subarray(0, 8), Buffer.from(sub)]);
}

function parseMflacFooter(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return { type: "unknown" };
  if (buffer.length >= 16 && buffer.subarray(buffer.length - 8).equals(MUSICEX_MAGIC)) {
    const version = buffer.readUInt32LE(buffer.length - 12);
    const footerSize = buffer.readUInt32LE(buffer.length - 16);
    if (version === 1 && footerSize >= 16 && footerSize <= buffer.length) {
      const metaStart = buffer.length - footerSize;
      const meta = buffer.subarray(metaStart, buffer.length - 16);
      const songId = meta.length > 4 ? meta.readUInt32LE(0) : 0;
      const readUtf16 = (offset, maxBytes) => {
        if (offset + 2 > meta.length) return "";
        const end = Math.min(meta.length, offset + maxBytes);
        let text = "";
        for (let i = offset; i + 1 < end; i += 2) {
          const code = meta.readUInt16LE(i);
          if (code === 0) break;
          text += String.fromCharCode(code);
        }
        return text;
      };
      const mediaMid = readUtf16(0x0c, 60);
      const filename = readUtf16(0x48, 68);
      return { type: "musicex", songId, mediaMid, filename, footerSize };
    }
  }
  if (buffer.length >= 12 && buffer.readUInt32LE(buffer.length - 4) === 0x67615451) {
    const metaSize = buffer.readUInt32BE(buffer.length - 8);
    const metaEnd = buffer.length - 8;
    const metaStart = metaEnd - metaSize;
    if (metaStart >= 0 && metaSize < 0x10000) {
      const meta = buffer.subarray(metaStart, metaEnd).toString("utf8");
      const parts = meta.split(",");
      if (parts.length >= 2) return { type: "qtag", ekey: parts[0], songId: parts[1] };
    }
  }
  const keySize = buffer.readUInt32LE(buffer.length - 4);
  if (keySize > 0 && keySize <= 0x400 && keySize < buffer.length - 8) return { type: "v1", keySize };
  return { type: "unknown" };
}

async function loadQqMusicCredentials(cookiePath) {
  const candidates = [cookiePath, getDefaultCookiePath()].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = await fsp.readFile(file, "utf8");
      const uinMatch = /(?:^|;\s*)uin=(\d+)/.exec(text);
      const authstMatch = /(?:^|;\s*)(qm_keyst|qqmusic_key|psrf_qqmusic_key)=([^;]+)/.exec(text);
      if (uinMatch && authstMatch) return { uin: uinMatch[1], authst: authstMatch[2] };
    } catch {
    }
  }
  return null;
}

async function fetchEkeyFromApi(creds, filename, songMid, options = {}) {
  const body = {
    comm: {
      authst: creds.authst,
      ct: "19",
      cv: "1859",
      uin: creds.uin,
      tme_login_type: "3"
    },
    req_1: {
      module: "music.vkey.GetEVkey",
      method: "CgiGetEVkey",
      param: {
        filename: [filename],
        guid: "10000",
        songmid: [songMid],
        songtype: [1],
        uin: creds.uin,
        loginflag: 1,
        platform: API_PLATFORM,
        ctx: 1
      }
    }
  };
  const bodyText = JSON.stringify(body);
  let responseBody;
  const timeout = timeoutWithinDeadline(options.deadline, 15000);
  try {
    responseBody = await requestHttps(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": API_UA,
        "Referer": "https://y.qq.com/"
      },
      body: bodyText,
      timeout,
      totalTimeout: timeout,
      maxBytes: MAX_MUSICEX_API_BYTES
    });
  } catch (error) {
    throw qmcError(`QQ 音乐接口请求失败：${error.message}。`, "MFLAC_EKEY_NETWORK");
  }
  let data;
  try {
    data = JSON.parse(responseBody.toString("utf8"));
  } catch {
    throw qmcError("QQ 音乐接口返回了无效数据。", "MFLAC_EKEY_NETWORK");
  }
  const info = data?.req_1?.data?.midurlinfo?.[0] || {};
  const sip = data?.req_1?.data?.sip;
  return { ekey: info.ekey || "", purl: info.purl || "", sip: Array.isArray(sip) ? sip : [] };
}

function musicexFallbackFilenames(mediaMid) {
  return [
    { filename: `F0M${mediaMid}.mflac`, label: "FLAC 无损" },
    { filename: `O4M${mediaMid}.mgg`, label: "OGG 高音质" },
    { filename: `M500${mediaMid}.mp3`, label: "MP3 320k" }
  ];
}

async function downloadMusicexFile(purl, sip, options = {}) {
  const bases = [...new Set([
    ...(Array.isArray(sip) ? sip.filter((item) => typeof item === "string") : []),
    "https://dl.stream.qqmusic.qq.com/"
  ])].slice(0, MAX_MUSICEX_SIP_COUNT);
  let lastError = null;
  for (const base of bases) {
    let url;
    try {
      url = resolveMusicexDownloadUrl(base, purl);
      const usedBytes = options.budget?.bytes || 0;
      const remainingBytes = MAX_MUSICEX_DOWNLOAD_BYTES - usedBytes;
      if (remainingBytes <= 0) throw qmcError("QQ 音乐降档下载超过总大小限制。", "MFLAC_EKEY_NETWORK");
      const timeout = timeoutWithinDeadline(options.deadline, 120000);
      const buf = await requestHttps(url.toString(), {
        timeout,
        totalTimeout: timeout,
        maxBytes: Math.min(MAX_MUSICEX_AUDIO_BYTES, remainingBytes)
      });
      if (options.budget) options.budget.bytes += buf.length;
      if (buf.length > 10000) return buf;
      throw new Error("下载内容过小");
    } catch (e) {
      lastError = e;
    }
  }
  throw qmcError(`下载加密音频失败：${lastError ? lastError.message : "未知错误"}。`, "MFLAC_EKEY_NETWORK");
}

async function decryptMusicexCandidates(creds, footer, originalFilename, originalBuf) {
  const deadline = Date.now() + MAX_MUSICEX_TOTAL_MS;
  const budget = { bytes: 0 };
  try {
    const first = await fetchEkeyFromApi(creds, originalFilename, footer.mediaMid, { deadline });
    if (first.ekey) {
      const decrypted = tryDecryptCandidates([{
        ekey: first.ekey,
        fileBuf: originalBuf,
        audioEnd: originalBuf.length - footer.footerSize,
        mutate: true,
        note: "原档"
      }]);
      if (decrypted) return decrypted;
    }
  } catch {
  }
  for (const fb of musicexFallbackFilenames(footer.mediaMid)) {
    try {
      const info = await fetchEkeyFromApi(creds, fb.filename, footer.mediaMid, { deadline });
      if (!info.ekey || !info.purl) continue;
      const fileBuf = await downloadMusicexFile(info.purl, info.sip, { deadline, budget });
      const fbFooter = parseMflacFooter(fileBuf);
      const audioEnd = fbFooter.type === "musicex" ? fileBuf.length - fbFooter.footerSize : fileBuf.length;
      const decrypted = tryDecryptCandidates([{ ekey: info.ekey, fileBuf, audioEnd, mutate: true, note: fb.label }]);
      if (decrypted) return decrypted;
    } catch {
    }
  }
  return null;
}

function tryDecryptCandidates(candidates) {
  for (const c of candidates) {
    try {
      const key = ekeyDecrypt(c.ekey);
      if (!key || key.length < 8) continue;
      const qmc2 = createQMC2(c.ekey);
      if (!qmc2) continue;
      const audio = c.mutate ? c.fileBuf.subarray(0, c.audioEnd) : Buffer.from(c.fileBuf.subarray(0, c.audioEnd));
      qmc2.decrypt(audio, 0);
      const format = detectAudioFormat(audio);
      if (format !== "unknown") return { audio, format };
    } catch {
    }
  }
  return null;
}

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).equals(FLAC_HEADER)) return "flac";
  if (buf.length > 3 && buf.subarray(0, 4).equals(OGG_HEADER)) return "ogg";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function normalizeMusicexFilename(filename, inputPath, inputExtension = "") {
  return /\.(mgg|mflac|mgg0|mgg1|mggl|mflac0|mflach|mmp4|mgg2|mflac2)$/i.test(filename)
    ? filename
    : `${filename}${inputExtension ? `.${inputExtension}` : path.extname(inputPath) || ".mflac"}`;
}

async function convertMflacImpl(inputPath, options = {}) {
  const buf = await readSpecialAudio(inputPath);
  if (buf.length < 16) throw qmcError("MFLAC 文件不完整。");
  const footer = parseMflacFooter(buf);
  let ekey = null;
  let qmc2 = null;
  let audioEnd = buf.length;
  let audioSource = buf;

  if (footer.type === "v1") {
    const keyStart = buf.length - 4 - footer.keySize;
    audioEnd = keyStart;
    const keyRegion = buf.subarray(keyStart, buf.length - 4);
    const parsed = parseV1KeyRegion(keyRegion);
    if (parsed.type === "encv2") {
      const finalKey = deriveQmcKey(parsed.ekey);
      qmc2 = finalKey.length < 300 ? new QMC2MAP(finalKey) : new QMC2RC4(finalKey);
    } else {
      ekey = keyRegion.toString("base64");
    }
  } else if (footer.type === "qtag") {
    ekey = footer.ekey;
    audioEnd = buf.length - 8 - (buf.readUInt32BE(buf.length - 8));
  } else if (footer.type === "musicex") {
    const apiFilename = normalizeMusicexFilename(footer.filename, inputPath, options.inputExtension);
    const creds = await loadQqMusicCredentials(options.cookiePath);
    if (!creds) {
      throw qmcError(
        "这个 MFLAC 是新版加密（musicex），需要 QQ 音乐登录凭据在线换取密钥；请把 QQ 音乐的登录 cookie 文件放到桌面（QQ音乐_登录cookie.txt）后重试。",
        "MFLAC_EKEY_REQUIRED"
      );
    }
    const decrypted = await decryptMusicexCandidates(creds, footer, apiFilename, buf);
    if (!decrypted) {
      throw qmcError(
        "这首歌的所有音质档位（含 FLAC/OGG/MP3 降级）都无在线密钥权限，可能已下架或需单独购买；请确认账号权限后重试。",
        "MFLAC_EKEY_NETWORK"
      );
    }
    return writeNativeAudio(decrypted.audio, decrypted.format, "mflac");
  } else {
    throw qmcError("无法识别这个 MFLAC 的加密版本（footer 缺失或格式未知）。");
  }

  if (!qmc2) {
    const key = ekeyDecrypt(ekey);
    if (!key || key.length < 8) throw qmcError("MFLAC 密钥解析失败。");
    qmc2 = createQMC2(ekey);
    if (!qmc2) throw qmcError("MFLAC 密钥不合法。");
  }

  const audio = audioSource.subarray(0, audioEnd);
  qmc2.decrypt(audio, 0);
  const format = detectAudioFormat(audio);
  if (format === "unknown") throw qmcError("MFLAC 解密结果不是可识别的音频格式。");

  return writeNativeAudio(audio, format, "mflac");
}

async function convertMflac(inputPath, options = {}) {
  try {
    return await convertMflacImpl(inputPath, options);
  } catch (error) {
    if (error?.code === "AUDIO_FILE_TOO_LARGE" || String(error?.code || "").startsWith("MFLAC_")) throw error;
    throw qmcError(`MFLAC 解密失败：${error.message || "输入格式无效"}。`);
  }
}

module.exports = { convertMflac, parseMflacFooter, parseV1KeyRegion, deriveQmcKey, loadQqMusicCredentials, fetchEkeyFromApi, musicexFallbackFilenames, tryDecryptCandidates, normalizeMusicexFilename };
