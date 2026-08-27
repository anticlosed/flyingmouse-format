const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { test, before, after } = require("node:test");

const { convertMflac, parseMflacFooter, parseV1KeyRegion, deriveQmcKey, musicexFallbackFilenames, loadQqMusicCredentials, tryDecryptCandidates, normalizeMusicexFilename } = require("../mflac-format");
const { convertKgg, QMC2MAP, QMC2RC4, createQMC2 } = require("../kgg-format");

const fakeCookieRoot = path.join(os.tmpdir(), `flyingmouse-mflac-cookie-${process.pid}`);
const hadCookieOverride = Object.prototype.hasOwnProperty.call(process.env, "FLYINGMOUSE_QQ_COOKIE");
const previousCookieOverride = process.env.FLYINGMOUSE_QQ_COOKIE;
before(() => {
  process.env.FLYINGMOUSE_QQ_COOKIE = path.join(fakeCookieRoot, "QQ音乐_登录cookie.txt");
});
after(() => {
  if (hadCookieOverride) process.env.FLYINGMOUSE_QQ_COOKIE = previousCookieOverride;
  else delete process.env.FLYINGMOUSE_QQ_COOKIE;
});

function makeMusicexFile({ songId = 203452364, mediaMid = "001fTFGe0LqzdT", filename = "F0M00007VNd52q6aSX.mflac" } = {}) {
  const meta = Buffer.alloc(176);
  meta.writeUInt32LE(songId, 0x00);
  Buffer.from(`${mediaMid}\x00`, "utf16le").copy(meta, 0x0c);
  Buffer.from(`${filename}\x00`, "utf16le").copy(meta, 0x48);
  const footerSize = 16 + meta.length;
  const footer = Buffer.alloc(footerSize);
  meta.copy(footer, 0);
  footer.writeUInt32LE(footerSize, footer.length - 16);
  footer.writeUInt32LE(1, footer.length - 12);
  Buffer.from("musicex\x00", "latin1").copy(footer, footer.length - 8);
  return Buffer.concat([Buffer.alloc(1024, 0x11), footer]);
}

function makeV1File(key) {
  const audio = Buffer.alloc(1024, 0x22);
  const keyBuf = Buffer.from(key);
  const tail = Buffer.alloc(4 + keyBuf.length);
  keyBuf.copy(tail, 0);
  tail.writeUInt32LE(keyBuf.length, tail.length - 4);
  return Buffer.concat([audio, tail]);
}

function makeInvalidQtagFile() {
  const ekey = Buffer.alloc(24, 6).toString("base64");
  const metadata = Buffer.from(`${ekey},0`, "utf8");
  const footer = Buffer.alloc(8);
  footer.writeUInt32BE(metadata.length, 0);
  footer.writeUInt32LE(0x67615451, 4);
  return Buffer.concat([Buffer.alloc(16, 0x11), metadata, footer]);
}

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-mflac-test-"));
}

test("parseMflacFooter detects musicex footer and extracts song metadata", () => {
  const footer = parseMflacFooter(makeMusicexFile());
  assert.equal(footer.type, "musicex");
  assert.equal(footer.songId, 203452364);
  assert.equal(footer.mediaMid, "001fTFGe0LqzdT");
  assert.equal(footer.filename, "F0M00007VNd52q6aSX.mflac");
});

test("parseMflacFooter detects QMC2 v1 footer", () => {
  const footer = parseMflacFooter(makeV1File(Buffer.alloc(16, 0xab)));
  assert.equal(footer.type, "v1");
  assert.equal(footer.keySize, 16);
});

test("parseMflacFooter returns unknown for unrecognized trailing data", () => {
  assert.equal(parseMflacFooter(Buffer.alloc(1024, 0x33)).type, "unknown");
});

test("parseMflacFooter treats truncated buffers as unknown", () => {
  for (let length = 0; length < 4; length += 1) {
    assert.deepEqual(parseMflacFooter(Buffer.alloc(length)), { type: "unknown" });
  }
});

test("convertMflac rejects an unrecognized mflac with a stable error code", async () => {
  const dir = await tmpDir();
  try {
    const badPath = path.join(dir, "bad.mflac");
    await fsp.writeFile(badPath, Buffer.alloc(256, 0x00));
    await assert.rejects(() => convertMflac(badPath), (error) => error.code === "MFLAC_DECRYPT_FAILED");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("convertMflac maps invalid QTag padding to a stable error", async () => {
  const dir = await tmpDir();
  try {
    const filePath = path.join(dir, "invalid.mflac");
    await fsp.writeFile(filePath, makeInvalidQtagFile());
    await assert.rejects(
      () => convertMflac(filePath),
      (error) => error.code === "MFLAC_DECRYPT_FAILED" && !/ERR_OUT_OF_RANGE/.test(error.message)
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("convertMflac on musicex without credentials reports MFLAC_EKEY_REQUIRED", async () => {
  const dir = await tmpDir();
  try {
    const mflacPath = path.join(dir, "sample.mflac");
    await fsp.writeFile(mflacPath, makeMusicexFile());
    await assert.rejects(
      () => convertMflac(mflacPath, { cookiePath: path.join(dir, "no-such-cookie.txt") }),
      (error) => error.code === "MFLAC_EKEY_REQUIRED"
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadQqMusicCredentials parses cookie credentials", async () => {
  const dir = await tmpDir();
  try {
    const cookiePath = path.join(dir, "cookie.txt");
    await fsp.writeFile(cookiePath, "uin=3461577342; qm_keyst=Q_H_L_TESTVALUE123; p_skey=IGNORED", "utf8");
    assert.deepEqual(await loadQqMusicCredentials(cookiePath), { uin: "3461577342", authst: "Q_H_L_TESTVALUE123" });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadQqMusicCredentials accepts psrf_qqmusic_key", async () => {
  const dir = await tmpDir();
  try {
    const cookiePath = path.join(dir, "cookie.txt");
    await fsp.writeFile(cookiePath, "uin=3461577342; psrf_qqmusic_key=PSRF_NEW_VALUE456; pgv_pvid=IGNORED", "utf8");
    assert.deepEqual(await loadQqMusicCredentials(cookiePath), { uin: "3461577342", authst: "PSRF_NEW_VALUE456" });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadQqMusicCredentials returns null when no cookie file exists", async () => {
  const dir = await tmpDir();
  try {
    assert.equal(await loadQqMusicCredentials(path.join(dir, "missing.txt")), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const encv2KeyFixture = path.join(__dirname, "fixtures", "mgg-encv2-key.bin");
const fixtureExists = fs.existsSync(encv2KeyFixture);

test("parseV1KeyRegion detects an EncV2 key fixture", { skip: !fixtureExists }, () => {
  const parsed = parseV1KeyRegion(fs.readFileSync(encv2KeyFixture));
  assert.equal(parsed.type, "encv2");
  assert.ok(parsed.ekey.length > 0);
});

test("deriveQmcKey produces a 256-byte QMC2 key", { skip: !fixtureExists }, () => {
  const parsed = parseV1KeyRegion(fs.readFileSync(encv2KeyFixture));
  const finalKey = deriveQmcKey(parsed.ekey);
  assert.equal(finalKey.length, 256);
});

test("convertMflac decrypts an EncV2 mgg fixture", { skip: !fixtureExists }, async () => {
  const keyRegion = fs.readFileSync(encv2KeyFixture);
  const parsed = parseV1KeyRegion(keyRegion);
  const finalKey = deriveQmcKey(parsed.ekey);
  const cipher = finalKey.length < 300 ? new QMC2MAP(finalKey) : new QMC2RC4(finalKey);
  const ogg = Buffer.concat([Buffer.from("OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 0x5a)]);
  const encrypted = Buffer.from(ogg);
  cipher.decrypt(encrypted, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(keyRegion.length, 0);
  const dir = await tmpDir();
  let result;
  try {
    const mggPath = path.join(dir, "sample.mgg");
    await fsp.writeFile(mggPath, Buffer.concat([encrypted, keyRegion, tail]));
    result = await convertMflac(mggPath);
    assert.equal(result.format, "ogg");
    assert.equal((await fsp.readFile(result.nativePath)).subarray(0, 4).toString("latin1"), "OggS");
  } finally {
    if (result) await fsp.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("special audio formats are registered and routed to the decrypt chain", () => {
  const configSource = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  assert.ok(configSource.includes('"mflac", "mgg"'));
  assert.ok(configSource.includes('"kgma", "mmp4"'));
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(serverSource.includes("unlockAudioInputs.has(inputExt)"));
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "mflac-format.js"), "utf8").includes("QQMusic EncV2,Key:"));
});

test("musicexFallbackFilenames generates descending quality candidates", () => {
  const list = musicexFallbackFilenames("00225ydR0y8KTj");
  assert.deepEqual(list.map((x) => x.filename), [
    "F0M00225ydR0y8KTj.mflac",
    "O4M00225ydR0y8KTj.mgg",
    "M50000225ydR0y8KTj.mp3"
  ]);
});

test("normalizeMusicexFilename preserves MMP4 and appends missing input extensions", () => {
  assert.equal(normalizeMusicexFilename("D0M001.mmp4", "sample.mmp4"), "D0M001.mmp4");
  assert.equal(normalizeMusicexFilename("D0M001", "temporary-upload", "mmp4"), "D0M001.mmp4");
});

test("tryDecryptCandidates falls back after an invalid candidate", () => {
  const ekey = Buffer.alloc(32).toString("base64");
  const cipher = createQMC2(ekey);
  const flac = Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(64, 0x01)]);
  const encryptedFlac = Buffer.from(flac);
  cipher.decrypt(encryptedFlac, 0);
  const garbageCandidate = { ekey, fileBuf: Buffer.from("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "latin1"), audioEnd: 32 };
  const goodCandidate = { ekey, fileBuf: encryptedFlac, audioEnd: encryptedFlac.length };
  const result = tryDecryptCandidates([garbageCandidate, goodCandidate]);
  assert.equal(result.format, "flac");
  assert.equal(result.audio.subarray(0, 4).toString("latin1"), "fLaC");
  assert.equal(tryDecryptCandidates([garbageCandidate]), null);
  assert.equal(tryDecryptCandidates([]), null);
});

test("QMC2 MAP and RC4 decrypt consistently across segment boundaries", () => {
  const cases = [
    {
      create: () => new QMC2MAP(Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1))),
      length: 0x8005,
      chunks: [0x7fff, 3]
    },
    {
      create: () => new QMC2RC4(Buffer.from(Array.from({ length: 300 }, (_, index) => (index % 251) + 1))),
      length: 0x80 + 0x1400 + 33,
      chunks: [0x7f, 2, 0x13ff]
    }
  ];
  for (const item of cases) {
    const plain = Buffer.from(Array.from({ length: item.length }, (_, index) => index & 0xff));
    const encrypted = Buffer.from(plain);
    item.create().decrypt(encrypted, 0);
    const decrypted = Buffer.from(encrypted);
    const decoder = item.create();
    let offset = 0;
    for (const chunkLength of item.chunks) {
      const end = Math.min(offset + chunkLength, decrypted.length);
      decoder.decrypt(decrypted.subarray(offset, end), offset);
      offset = end;
    }
    if (offset < decrypted.length) decoder.decrypt(decrypted.subarray(offset), offset);
    assert.deepEqual(decrypted, plain);
  }
});

test("convertKgg rejects truncated and unsupported headers before key lookup", async (t) => {
  const dir = await tmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const truncatedPath = path.join(dir, "truncated.kgg");
  await fsp.writeFile(truncatedPath, Buffer.alloc(75, 0x00));
  await assert.rejects(() => convertKgg(truncatedPath), /KGG 文件不完整/);
  const unsupportedPath = path.join(dir, "unsupported.kgg");
  const unsupported = Buffer.alloc(80, 0x00);
  unsupported.writeUInt32LE(76, 16);
  unsupported.writeUInt32LE(4, 20);
  await fsp.writeFile(unsupportedPath, unsupported);
  await assert.rejects(() => convertKgg(unsupportedPath), /mode=4/);
});

test("musicex tries fallback candidates in order and stops after the first success", async (t) => {
  const dir = await tmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cookiePath = path.join(dir, "cookie.txt");
  await fsp.writeFile(cookiePath, "uin=3461577342; qm_keyst=Q_H_L_TESTVALUE123", "utf8");
  const originalPath = path.join(dir, "sample.mflac");
  await fsp.writeFile(originalPath, makeMusicexFile());

  const ekey = Buffer.alloc(32).toString("base64");
  const plain = Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(12000, 0x5a)]);
  const cipher = createQMC2(ekey);
  const encrypted = Buffer.from(plain);
  cipher.decrypt(encrypted, 0);
  const apiFilenames = [];
  const downloadUrls = [];
  const originalRequest = https.request;
  https.request = (url, _options, callback) => {
    const request = new EventEmitter();
    let body = "";
    request.write = (chunk) => {
      body += chunk;
    };
    request.end = () => {
      const requestUrl = String(url);
      let responseBody = Buffer.alloc(0);
      if (requestUrl.includes("u.y.qq.com")) {
        const requestBody = JSON.parse(body);
        const filename = requestBody.req_1.param.filename[0];
        apiFilenames.push(filename);
        if (filename === "F0M00007VNd52q6aSX.mflac") {
          responseBody = Buffer.from(JSON.stringify({ req_1: { data: { midurlinfo: [{ ekey: "", purl: "" }], sip: [] } } }));
        } else if (filename.endsWith(".mflac")) {
          responseBody = Buffer.from(JSON.stringify({ req_1: { data: { midurlinfo: [{ ekey, purl: "https://dl.stream.qqmusic.qq.com/invalid.mflac" }], sip: [] } } }));
        } else if (filename.endsWith(".mgg")) {
          responseBody = Buffer.from(JSON.stringify({ req_1: { data: { midurlinfo: [{ ekey, purl: "https://dl.stream.qqmusic.qq.com/success.mgg" }], sip: [] } } }));
        } else {
          responseBody = Buffer.from(JSON.stringify({ req_1: { data: { midurlinfo: [{ ekey, purl: "https://dl.stream.qqmusic.qq.com/unexpected.mp3" }], sip: [] } } }));
        }
      } else {
        downloadUrls.push(requestUrl);
        responseBody = requestUrl.endsWith("success.mgg") ? encrypted : Buffer.alloc(12001, 0x11);
      }
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.resume = () => {};
      response.destroy = () => {};
      queueMicrotask(() => {
        callback(response);
        queueMicrotask(() => {
          if (responseBody.length > 0) response.emit("data", responseBody);
          response.emit("end");
        });
      });
    };
    return request;
  };

  let result;
  try {
    result = await convertMflac(originalPath, { cookiePath });
    assert.equal(result.format, "flac");
    assert.deepEqual(await fsp.readFile(result.nativePath), plain);
    assert.deepEqual(apiFilenames, [
      "F0M00007VNd52q6aSX.mflac",
      "F0M001fTFGe0LqzdT.mflac",
      "O4M001fTFGe0LqzdT.mgg"
    ]);
    assert.deepEqual(downloadUrls, [
      "https://dl.stream.qqmusic.qq.com/invalid.mflac",
      "https://dl.stream.qqmusic.qq.com/success.mgg"
    ]);
  } finally {
    if (result) await fsp.rm(result.tempDir, { recursive: true, force: true });
    https.request = originalRequest;
  }
});
