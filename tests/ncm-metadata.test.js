const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { normalizeNcmMetadata, buildNcmFfmpegOptions } = require("../ncm-metadata");
const { convertNcm, detectCoverFormat } = require("../ncm-format");

const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex");

function encryptNcmKey(data) {
  const cipher = crypto.createCipheriv("aes-128-ecb", CORE_KEY, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  for (let index = 0; index < encrypted.length; index += 1) encrypted[index] ^= 0x64;
  return encrypted;
}

function ncmKeyStream(key) {
  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) state[index] = index;
  let cursor = 0;
  for (let index = 0; index < 256; index += 1) {
    cursor = (cursor + state[index] + key[index % key.length]) & 255;
    const value = state[index];
    state[index] = state[cursor];
    state[cursor] = value;
  }
  const stream = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) {
    const a = (index + 1) & 255;
    const b = state[(a + state[a]) & 255];
    stream[index] = state[(state[a] + b) & 255];
  }
  return stream;
}

function makeSyntheticNcm(audio) {
  const rc4key = Buffer.from("mouse-key01", "ascii");
  const keyBox = Buffer.alloc(32, 0x04);
  Buffer.alloc(17, 0x11).copy(keyBox, 0);
  rc4key.copy(keyBox, 17);
  const encryptedKey = encryptNcmKey(keyBox);
  const encryptedAudio = Buffer.from(audio);
  const stream = ncmKeyStream(rc4key);
  for (let index = 0; index < encryptedAudio.length; index += 1) encryptedAudio[index] ^= stream[index & 255];
  const header = Buffer.alloc(14);
  Buffer.from("CTENFDAM", "latin1").copy(header, 0);
  header.writeUInt32LE(encryptedKey.length, 10);
  const metadata = Buffer.alloc(18);
  metadata.writeUInt32LE(1, 0);
  metadata.writeUInt32LE(0, 14);
  return Buffer.concat([header, encryptedKey, metadata, encryptedAudio]);
}

test("normalizes common NCM metadata shapes", () => {
  assert.deepEqual(normalizeNcmMetadata({
    musicName: "Song",
    artist: [["Mouse", 1], ["Cat", 2]],
    album: "Album"
  }), {
    title: "Song",
    artist: "Mouse / Cat",
    album: "Album"
  });
});

test("builds safe FFmpeg metadata and cover options for MP3", () => {
  const options = buildNcmFfmpegOptions({
    metadata: { title: "Song", artist: "Mouse", album: "Album" },
    coverPath: "cover.png"
  }, "mp3");
  assert.deepEqual(options.extraInputs, ["cover.png"]);
  assert.deepEqual(options.metadata, { title: "Song", artist: "Mouse", album: "Album" });
  assert.deepEqual(options.coverArgs, [
    "-map", "0:a:0", "-map", "1:v:0", "-c:v", "mjpeg",
    "-id3v2_version", "4", "-disposition:v:0", "attached_pic"
  ]);
});

test("does not attach unsupported cover streams while keeping text metadata", () => {
  const options = buildNcmFfmpegOptions({
    metadata: { title: "Song" },
    coverPath: "cover.png"
  }, "ogg");
  assert.deepEqual(options.extraInputs, []);
  assert.deepEqual(options.coverArgs, []);
  assert.equal(options.metadata.title, "Song");
});

test("accepts only recognizable complete PNG and JPEG cover payloads", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).jpeg().toBuffer();
  assert.equal(detectCoverFormat(png), "png");
  assert.equal(detectCoverFormat(jpeg), "jpg");
  assert.equal(detectCoverFormat(Buffer.from("89504e470d0a1a0a00000000", "hex")), null);
  assert.equal(detectCoverFormat(Buffer.from("ffd8ffe00000ffd9", "hex")), null);
  assert.equal(detectCoverFormat(Buffer.from("not-an-image")), null);
});

test("convertNcm decrypts a synthetic FLAC across the 256-byte key-stream boundary", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ncm-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "sample.ncm");
  const audio = Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(600, 0x5a)]);
  await fsp.writeFile(inputPath, makeSyntheticNcm(audio));
  const result = await convertNcm(inputPath);
  try {
    assert.equal(result.format, "flac");
    assert.deepEqual(await fsp.readFile(result.nativePath), audio);
    assert.deepEqual(result.metadata, {});
  } finally {
    await fsp.rm(result.tempDir, { recursive: true, force: true });
  }
});

test("convertNcm rejects input without the CTENFDAM header", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ncm-invalid-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "invalid.ncm");
  await fsp.writeFile(inputPath, Buffer.alloc(64, 0x00));
  await assert.rejects(() => convertNcm(inputPath), /CTENFDAM/);
});
