const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { convertKgma, kugoMd5, xorCollapseU32, detectAudioFormat } = require("../kgma-format");

const KGM_HEADER = Buffer.from([
  0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b,
  0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14
]);

function encryptKgmaAudio(audio, cryptoKey) {
  const slotBox = kugoMd5(Buffer.from([0x6c, 0x2c, 0x2f, 0x27]));
  const fileBox = Buffer.concat([kugoMd5(cryptoKey), Buffer.from([0x6b])]);
  const encrypted = Buffer.from(audio);
  for (let index = 0; index < encrypted.length; index += 1) {
    let value = encrypted[index];
    value ^= xorCollapseU32(index);
    value ^= slotBox[index % slotBox.length];
    value ^= (value << 4) & 0xff;
    value ^= fileBox[index % fileBox.length];
    encrypted[index] = value;
  }
  return encrypted;
}

test("kugoMd5 reverses digest byte order by 16-bit groups", () => {
  const input = Buffer.from([0x6c, 0x2c, 0x2f, 0x27]);
  const digest = crypto.createHash("md5").update(input).digest();
  const expected = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 2) {
    expected[i] = digest[14 - i];
    expected[i + 1] = digest[15 - i];
  }
  assert.deepEqual(kugoMd5(input), expected);
});

test("xorCollapseU32 folds four bytes with XOR", () => {
  assert.equal(xorCollapseU32(0), 0);
  assert.equal(xorCollapseU32(0x01020304), 0x01 ^ 0x02 ^ 0x03 ^ 0x04);
  assert.equal(xorCollapseU32(0xffffffff), 0xff ^ 0xff ^ 0xff ^ 0xff);
});

test("detectAudioFormat recognizes flac/mp3/ogg", () => {
  assert.equal(detectAudioFormat(Buffer.from("fLaC\x00\x00\x00\x00")), "flac");
  assert.equal(detectAudioFormat(Buffer.from("ID3\x04\x00")), "mp3");
  assert.equal(detectAudioFormat(Buffer.from("OggS\x00\x02")), "ogg");
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90])), "mp3");
  assert.equal(detectAudioFormat(Buffer.from([0x00, 0x01, 0x02, 0x03])), "unknown");
});

test("convertKgma rejects a non-KGM magic header", async () => {
  const tmp = path.join(require("node:os").tmpdir(), `kgma-bad-${process.pid}.kgma`);
  fs.writeFileSync(tmp, Buffer.alloc(0x40, 0x11));
  try {
    await assert.rejects(() => convertKgma(tmp), /不是合法的 KGM\/KGMA/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKgma rejects unsupported version and slot", async () => {
  const versionPath = path.join(require("node:os").tmpdir(), `kgma-v5-${process.pid}.kgma`);
  const versionBuffer = Buffer.alloc(1024 + 16, 0x22);
  KGM_HEADER.copy(versionBuffer, 0);
  versionBuffer.writeUInt32LE(1024, 0x10);
  versionBuffer.writeUInt32LE(5, 0x14);
  fs.writeFileSync(versionPath, versionBuffer);
  try {
    await assert.rejects(() => convertKgma(versionPath), /仅支持 KGMA\/v3/);
  } finally {
    fs.rmSync(versionPath, { force: true });
  }

  const slotPath = path.join(require("node:os").tmpdir(), `kgma-slot-${process.pid}.kgma`);
  const slotBuffer = Buffer.alloc(1024 + 16, 0x33);
  KGM_HEADER.copy(slotBuffer, 0);
  slotBuffer.writeUInt32LE(1024, 0x10);
  slotBuffer.writeUInt32LE(3, 0x14);
  slotBuffer.writeUInt32LE(9, 0x18);
  fs.writeFileSync(slotPath, slotBuffer);
  try {
    await assert.rejects(() => convertKgma(slotPath), /仅支持 1/);
  } finally {
    fs.rmSync(slotPath, { force: true });
  }
});

test("convertKgma round-trips a synthetic v3 slot-1 sample", async () => {
  const inputPath = path.join(require("node:os").tmpdir(), `kgma-roundtrip-${process.pid}.kgma`);
  const cryptoKey = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plain = Buffer.concat([
    Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"),
    Buffer.alloc(512, 0x5a)
  ]);
  const header = Buffer.alloc(0x40, 0x00);
  KGM_HEADER.copy(header, 0);
  header.writeUInt32LE(header.length, 0x10);
  header.writeUInt32LE(3, 0x14);
  header.writeUInt32LE(1, 0x18);
  cryptoKey.copy(header, 0x2c);
  fs.writeFileSync(inputPath, Buffer.concat([header, encryptKgmaAudio(plain, cryptoKey)]));
  let result;
  try {
    result = await convertKgma(inputPath);
    assert.equal(result.format, "mp3");
    assert.deepEqual(fs.readFileSync(result.nativePath), plain);
  } finally {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    fs.rmSync(inputPath, { force: true });
  }
});

test("convertKgma decrypts a real fixture when available", { skip: !fs.existsSync(path.join(__dirname, "fixtures", "sample.kgma")) }, async () => {
  const fixture = path.join(__dirname, "fixtures", "sample.kgma");
  const { nativePath, format } = await convertKgma(fixture);
  try {
    assert.ok(["flac", "mp3", "ogg"].includes(format));
    const head = fs.readFileSync(nativePath).subarray(0, 4);
    if (format === "flac") assert.equal(head.toString("latin1"), "fLaC");
    if (format === "ogg") assert.equal(head.toString("latin1"), "OggS");
  } finally {
    fs.rmSync(path.dirname(nativePath), { recursive: true, force: true });
  }
});
