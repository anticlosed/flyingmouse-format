const assert = require("node:assert/strict");
const { test } = require("node:test");

const { videoEncoderArgs, alphaCompositeArgs } = require("../media");
const { createMediaProgressObserver, convertMedia } = require("../media");

test("videoEncoderArgs 默认与 h264 → libx264 crf23", () => {
  const expected = ["-codec:v", "libx264", "-preset", "medium", "-crf", "23"];
  assert.deepEqual(videoEncoderArgs(undefined), expected);
  assert.deepEqual(videoEncoderArgs("h264"), expected);
});

test("videoEncoderArgs h265/hevc → libx265 crf28", () => {
  const expected = ["-codec:v", "libx265", "-preset", "medium", "-crf", "28"];
  assert.deepEqual(videoEncoderArgs("h265"), expected);
  assert.deepEqual(videoEncoderArgs("hevc"), expected);
});

test("videoEncoderArgs av1 → libsvtav1 preset8 crf32", () => {
  assert.deepEqual(videoEncoderArgs("av1"), ["-codec:v", "libsvtav1", "-preset", "8", "-crf", "32"]);
});

test("videoEncoderArgs 未知编码回退 h264", () => {
  const expected = ["-codec:v", "libx264", "-preset", "medium", "-crf", "23"];
  assert.deepEqual(videoEncoderArgs("vp9"), expected);
  assert.deepEqual(videoEncoderArgs(""), expected);
});

test("alphaCompositeArgs 对无 alpha 视频返回 null", () => {
  assert.equal(alphaCompositeArgs(null), null);
  assert.equal(alphaCompositeArgs({ hasAlpha: false, width: 640, height: 480, fps: 30 }), null);
});

test("alphaCompositeArgs 对带 alpha 视频生成白底合成参数", () => {
  const result = alphaCompositeArgs({ hasAlpha: true, width: 1466, height: 1080, fps: 30 });
  assert.ok(result);
  assert.deepEqual(result.inputs, ["-f", "lavfi", "-i", "color=white:s=1466x1080:r=30"]);
  assert.match(result.filterComplex, /overlay=shortest=1/);
  assert.match(result.filterComplex, /\[1:v\]\[0:v\]/);
  assert.equal(result.videoLabel, "alphaout");
});

test("alphaCompositeArgs 对未知宽高用兜底尺寸", () => {
  const result = alphaCompositeArgs({ hasAlpha: true, width: 0, height: 0, fps: 0 });
  assert.ok(result);
  assert.match(result.inputs[3], /s=1280x720:r=30/);
});

test("alphaCompositeArgs 支持自定义背景色（black/hex/颜色名）", () => {
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "black").inputs[3], /color=black:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "0x00ff00").inputs[3], /color=0x00ff00:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "#ff00ff").inputs[3], /color=#ff00ff:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "red").inputs[3], /color=red:/);
});

test("alphaCompositeArgs 对非法背景色回退 white（防注入）", () => {
  const result = alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "white:s=1;evil");
  assert.match(result.inputs[3], /color=white:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "").inputs[3], /color=white:/);
});

test("FFmpeg progress parses chunked microseconds and actual input duration, never out_time_ms", () => {
  const events = [];
  const observer = createMediaProgressObserver(event => events.push(event));
  observer.onStderr(Buffer.from("Input #0, wav, from 'private.wav':\n  Dura"));
  observer.onStderr(Buffer.from("tion: 00:00:06.50, bitrate: 123 kb/s\n"));
  observer.onStdout(Buffer.from("out_time_ms=99000000\nout_ti"));
  observer.onStdout(Buffer.from("me_us=1500000\nprogress=continue\n"));
  assert.deepEqual(events.at(-1), { stage: "converting", completed: 1.5, total: 6.5, unit: "seconds" });
  const count = events.length;
  observer.onStdout(Buffer.from("out_time_us=-1\nout_time_us=500000\n"));
  assert.equal(events.length, count);
  observer.close();
  observer.onStdout(Buffer.from("out_time_us=3000000\n"));
  assert.equal(events.length, count, "closed observer cannot report late events");
});

test("unknown and multiple-input durations remain unknown while actual processed seconds advance", () => {
  for (const options of [{}, { allowDuration: false }]) {
    const events = [];
    const observer = createMediaProgressObserver(event => events.push(event), options);
    observer.onStderr(Buffer.from(options.allowDuration === false
      ? "Input #0, wav:\n Duration: 00:00:06.00, bitrate: 123\n"
      : "Input #0, wav:\n Duration: N/A, bitrate: 123\n"));
    observer.onStdout(Buffer.from("out_time_us=1200000\n"));
    assert.deepEqual(events.at(-1), { stage: "converting", completed: 1.2, total: null, unit: "seconds" });
    observer.close();
  }
});

test("real limited-rate FFmpeg reports intermediate seconds and ordinary media conversion keeps a valid MP3", async t => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
  const { FFMPEG_PATH } = require("../config");
  const { run, commandExists } = require("../utils");
  if (!(await commandExists(FFMPEG_PATH))) return t.skip("real FFmpeg is unavailable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-progress-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input.mp4"), output = path.join(root, "output.mp3");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=white:s=64x48:r=10:d=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-codec:v", "libx264", "-preset", "ultrafast", "-codec:a", "aac", input]);
  const events = [];
  let finished = false;
  const observer = createMediaProgressObserver(event => { assert.equal(finished, false); events.push(event); });
  try {
    await run(FFMPEG_PATH, ["-hide_banner", "-y", "-re", "-i", input, "-codec:a", "libmp3lame", "-progress", "pipe:1", "-nostats", output], {
      timeout: 15000, onStdout: observer.onStdout, onStderr: observer.onStderr
    });
  } finally { finished = true; observer.close(); }
  assert.ok(events.some(event => event.total === 6 && event.completed > 0 && event.completed < event.total), "at least one real intermediate report must arrive before process completion");
  t.diagnostic(JSON.stringify({ actualIntermediate: events.filter(event => event.total === 6 && event.completed > 0 && event.completed < event.total), finalNativeReport: events.at(-1) }));
  await convertMedia(input, path.join(root, "ordinary.mp3"), "mp3", "video");
  const decoded = await run(FFMPEG_PATH, ["-hide_banner", "-i", path.join(root, "ordinary.mp3"), "-f", "null", "-"]);
  assert.match(decoded.stderr, /Audio:/);
});
