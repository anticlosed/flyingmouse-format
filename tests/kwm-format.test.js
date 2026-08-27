const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");

const { convertKwm, generateMask, padOrTruncate, detectAudioFormat, KWM_HEADER_SIZE } = require("../kwm-format");

test("padOrTruncate cycles a short value to 32 bytes", () => {
  assert.deepEqual(padOrTruncate(Buffer.from("557589985", "ascii"), 32), Buffer.from("55758998555758998555758998555758", "ascii"));
});

test("padOrTruncate truncates a long value", () => {
  const out = padOrTruncate(Buffer.from("1234567890123456789012345678901234567890", "ascii"), 32);
  assert.equal(out.length, 32);
  assert.equal(out.toString("ascii"), "12345678901234567890123456789012");
});

test("padOrTruncate zero-fills an empty value", () => {
  assert.ok(padOrTruncate(Buffer.alloc(0), 32).every((byte) => byte === 0));
});

test("generateMask matches the known KWM key", () => {
  const key8 = Buffer.from([0xe1, 0x25, 0x3c, 0x21, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(generateMask(key8)[0], 0x4d ^ 0x35);
});

test("detectAudioFormat recognizes mp3/flac/ogg", () => {
  assert.equal(detectAudioFormat(Buffer.from("ID3\x04\x00\x00\x00")), "mp3");
  assert.equal(detectAudioFormat(Buffer.from("fLaC\x00\x00\x00\x00")), "flac");
  assert.equal(detectAudioFormat(Buffer.from("OggS\x00\x02")), "ogg");
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90])), "mp3");
  assert.equal(detectAudioFormat(Buffer.from([0x00, 0x01, 0x02, 0x03])), "unknown");
});

test("convertKwm rejects invalid input", async () => {
  const bad = path.join(require("node:os").tmpdir(), `kwm-bad-${process.pid}.kwm`);
  fs.writeFileSync(bad, Buffer.alloc(KWM_HEADER_SIZE + 16, 0x11));
  try {
    await assert.rejects(() => convertKwm(bad), /不是合法的 KWM/);
  } finally {
    fs.rmSync(bad, { force: true });
  }
  const short = path.join(require("node:os").tmpdir(), `kwm-short-${process.pid}.kwm`);
  fs.writeFileSync(short, Buffer.alloc(16, 0x22));
  try {
    await assert.rejects(() => convertKwm(short), /KWM 文件不完整/);
  } finally {
    fs.rmSync(short, { force: true });
  }
});

test("convertKwm round-trips a synthetic encrypted sample", async () => {
  const key8 = Buffer.from([0xe1, 0x25, 0x3c, 0x21, 0x00, 0x00, 0x00, 0x00]);
  const mask = generateMask(key8);
  const plain = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.from("fake audio payload for kwm roundtrip test", "ascii")]);
  const encrypted = Buffer.from(plain);
  for (let i = 0; i < encrypted.length; i++) encrypted[i] ^= mask[i & 0x1f];
  const header = Buffer.alloc(KWM_HEADER_SIZE, 0x00);
  Buffer.from("yeelion-kuwo-tme", "latin1").copy(header, 0);
  key8.copy(header, 0x18);
  Buffer.from("320MP3", "latin1").copy(header, 0x30);
  const tmp = path.join(require("node:os").tmpdir(), `kwm-roundtrip-${process.pid}.kwm`);
  fs.writeFileSync(tmp, Buffer.concat([header, encrypted]));
  let result;
  try {
    result = await convertKwm(tmp);
    assert.equal(result.format, "mp3");
    assert.deepEqual(fs.readFileSync(result.nativePath), plain);
  } finally {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKwm decrypts a real fixture when available", { skip: !fs.existsSync(path.join(__dirname, "fixtures", "sample.kwm")) }, async () => {
  const result = await convertKwm(path.join(__dirname, "fixtures", "sample.kwm"));
  try {
    assert.ok(["mp3", "flac"].includes(result.format));
    assert.ok(fs.readFileSync(result.nativePath).length > 1000);
  } finally {
    fs.rmSync(result.tempDir, { recursive: true, force: true });
  }
});
