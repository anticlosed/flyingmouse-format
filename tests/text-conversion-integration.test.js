const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { after, before, test } = require("node:test");

const runtimeDir = path.join(os.tmpdir(), `flyingmouse-text-integration-${process.pid}`);
process.env.FLYINGMOUSE_RUNTIME_DIR = runtimeDir;
// csv->pdf 走 LibreOffice html->pdf 管线；使用当前配置的引擎，不绑定开发者安装目录。
// 注意必须用 soffice.com（命令行壳）：portable 版 soffice.exe 会拉起 GUI 挂起，probe 超时。
const candidateLo = require("../config").LIBREOFFICE_PATH;
const LO_AVAILABLE = require("node:fs").existsSync(candidateLo);
if (LO_AVAILABLE) process.env.FLYINGMOUSE_LIBREOFFICE_PATH = candidateLo;
const { startServer, createServerUploadStorage, platformCapabilities } = require("../server");
const { DCRAW_PATH, audioInput, mediaAudioTargets, rawInput, unlockAudioInputs, experimentalInputsByCategory } = require("../config");
const { MAX_SPECIAL_AUDIO_BYTES } = require("../audio-format-utils");
const { categoryForExt, targetsForExt, extFromName } = require("../utils");

const SPECIAL_AUDIO_EXTENSIONS = ["ncm", "kgg", "mflac", "mgg", "kgma", "mmp4", "kwm"];

let server;
let baseUrl;

before(async () => {
  const started = await startServer(0);
  server = started.server;
  baseUrl = started.url;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

async function convert(name, content, targetFormat, type) {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  form.append("targetFormat", targetFormat);
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  return download.text();
}

async function convertResponse(name, content, targetFormat, type) {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  form.append("targetFormat", targetFormat);
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  return { response, body: await response.json() };
}

test("server preserves HTML headings and lists when converting to Markdown", async () => {
  const markdown = await convert(
    "page.html",
    "<h1>Hello</h1><ul><li>Mouse</li><li>Format</li></ul>",
    "md",
    "text/html"
  );
  assert.match(markdown, /^# Hello/m);
  assert.match(markdown, /^\*\s+Mouse/m);
});

test("server preserves legal quoted newlines when converting CSV to JSON", async () => {
  const json = await convert(
    "table.csv",
    '"name","description"\r\n"鼠鼠","第一行\r\n第二行"\r\n',
    "json",
    "text/csv"
  );
  assert.deepEqual(JSON.parse(json), [{ name: "鼠鼠", description: "第一行\r\n第二行" }]);
});

test("server reports invalid CSV as a stable client error", async () => {
  const { response, body } = await convertResponse(
    "duplicate.csv",
    "name,name\nfirst,second\n",
    "json",
    "text/csv"
  );
  assert.equal(response.status, 422);
  assert.equal(body.errorCode, "CSV_PARSE_FAILED");
  assert.match(body.error, /CSV/);
});

test("server flags txt to JSON as a raw-text wrapper warning instead of pretending to parse", async () => {
  const { response, body } = await convertResponse(
    "note.txt",
    "just some plain text\nno structure here",
    "json",
    "text/plain"
  );
  assert.equal(response.status, 200, body.error);
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  const payload = JSON.parse(await download.text());
  assert.equal(payload.text, "just some plain text\nno structure here");
  assert.ok(Array.isArray(body.warnings), "expected warnings array");
  assert.ok(body.warnings.some((warning) => warning.code === "TEXT_JSON_WRAPPED"));
});

test("server returns a client error for unsupported mathematics and corrupt ebook containers", async () => {
  const math = await convertResponse("equation.md", "$\\unsupportedMouseMacro{x}$", "html", "text/markdown");
  assert.equal(math.response.status, 422);
  assert.equal(math.body.errorCode, "MARKDOWN_MATH_UNSUPPORTED");
  assert.match(math.body.messages.enUS, /mathematics/);
  for (const extension of ["epub", "mobi"]) {
    const result = await convertResponse(`corrupt.${extension}`, "invalid binary container", "txt", "application/octet-stream");
    assert.equal(result.response.status, 422);
    assert.match(result.body.errorCode, /^(EPUB|MOBI)_PARSE_FAILED$/);
  }
});

test("server exposes the real Pandoc probe and propagates missing Markdown image warnings", async (t) => {
  const capabilities = await (await fetch(`${baseUrl}/api/capabilities`)).json();
  assert.equal(typeof capabilities.tools.pandoc, "boolean");
  assert.equal(capabilities.toolDetails.pandoc.enabled, capabilities.tools.pandoc);
  if (!capabilities.tools.pandoc) return t.skip("Bundled Pandoc is unavailable on this test host");
  const result = await convertResponse("rich.md", "# Heading\n\n$E=mc^2$\n\n![图片](missing.png)", "docx", "text/markdown");
  assert.equal(result.response.status, 200, result.body.error);
  assert.ok(result.body.warnings.some((warning) => warning.code === "MARKDOWN_IMAGE_UNAVAILABLE"));
  const buffer = Buffer.from(await (await fetch(`${baseUrl}${result.body.downloadUrl}`)).arrayBuffer());
  assert.equal(buffer.toString("ascii", 0, 2), "PK");
});

test("server converts CSV to JSON without the wrapper warning (real parse)", async () => {
  const { response, body } = await convertResponse(
    "data.csv",
    "name,age\nAlice,30\n",
    "json",
    "text/csv"
  );
  assert.equal(response.status, 200, body.error);
  assert.ok(!Array.isArray(body.warnings) || !body.warnings.some((warning) => warning.code === "TEXT_JSON_WRAPPED"));
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  const payload = JSON.parse(await download.text());
  assert.deepEqual(payload, [{ name: "Alice", age: "30" }]);
});

test("server converts CSV to a real EPUB (not a LO fake success)", async () => {
  const { response, body } = await convertResponse(
    "rows.csv",
    "name,age\nAlice,30\nBob,25\n",
    "epub",
    "text/csv"
  );
  assert.equal(response.status, 200, body.error);
  assert.equal(body.fileName, "rows.epub");
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  const buffer = Buffer.from(await download.arrayBuffer());
  // EPUB 规范：第一个条目是明文 mimetype
  assert.match(buffer.toString("latin1", 0, 1024), /application\/epub\+zip/);
});

test("server converts CSV to XLSX with real cells (not a LO fake success)", async () => {
  const { response, body } = await convertResponse(
    "rows.csv",
    "name,age\nAlice,30\nBob,25\n",
    "xlsx",
    "text/csv"
  );
  assert.equal(response.status, 200, body.error);
  assert.equal(body.fileName, "rows.xlsx");
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  const buffer = Buffer.from(await download.arrayBuffer());
  assert.equal(buffer.toString("latin1", 0, 2), "PK", "xlsx must be a zip archive");
  const { Workbook } = require("exceljs");
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Sheet1");
  assert.equal(sheet.getCell("A1").value, "name");
  assert.equal(sheet.getCell("B2").value, "30");
  assert.equal(sheet.getCell("A3").value, "Bob");
});

test("server converts CSV to PDF and HTML with a real table", { skip: !LO_AVAILABLE }, async () => {
  const pdf = await convertResponse("rows.csv", "name,age\nAlice,30\n", "pdf", "text/csv");
  assert.equal(pdf.response.status, 200, pdf.body.error);
  assert.equal(pdf.body.fileName, "rows.pdf");
  const pdfDownload = await fetch(`${baseUrl}${pdf.body.downloadUrl}`);
  const pdfBuffer = Buffer.from(await pdfDownload.arrayBuffer());
  assert.equal(pdfBuffer.toString("latin1", 0, 4), "%PDF", "csv->pdf must produce a real PDF");

  const html = await convertResponse("rows.csv", "name,age\nAlice,30\n", "html", "text/csv");
  assert.equal(html.response.status, 200, html.body.error);
  assert.equal(html.body.fileName, "rows.html");
  const htmlDownload = await fetch(`${baseUrl}${html.body.downloadUrl}`);
  const htmlText = await htmlDownload.text();
  assert.match(htmlText, /<table>/);
  assert.match(htmlText, /Alice/);
});

test("server converts TSV through the same real pipelines as CSV", async () => {
  const json = await convertResponse("data.tsv", "name\tage\nAlice\t30\n", "json", "text/tab-separated-values");
  assert.equal(json.response.status, 200, json.body.error);
  const jsonDownload = await fetch(`${baseUrl}${json.body.downloadUrl}`);
  assert.deepEqual(JSON.parse(await jsonDownload.text()), [{ name: "Alice", age: "30" }]);

  const md = await convertResponse("data.tsv", "name\tage\nAlice\t30\n", "md", "text/tab-separated-values");
  assert.equal(md.response.status, 200, md.body.error);
  const mdDownload = await fetch(`${baseUrl}${md.body.downloadUrl}`);
  assert.match(await mdDownload.text(), /\| name \| age \|/);

  const xlsx = await convertResponse("data.tsv", "name\tage\nAlice\t30\n", "xlsx", "text/tab-separated-values");
  assert.equal(xlsx.response.status, 200, xlsx.body.error);
  const xlsxDownload = await fetch(`${baseUrl}${xlsx.body.downloadUrl}`);
  const xlsxBuffer = Buffer.from(await xlsxDownload.arrayBuffer());
  assert.equal(xlsxBuffer.toString("latin1", 0, 2), "PK", "tsv->xlsx must be a zip archive");
});

test("capabilities expose stable conversion limits and Sharp keeps pixel protection enabled", async () => {
  const response = await fetch(`${baseUrl}/api/capabilities`);
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.deepEqual(capabilities.limits, require('../resource-policy').LIMITS);
  assert.ok(capabilities.limits.maxImagePixels < 100_000_000);
  assert.ok(capabilities.limits.maxBatchBytes < Number.MAX_SAFE_INTEGER);
  assert.deepEqual(capabilities.groups.image.experimentalInputs, [...experimentalInputsByCategory.image, ...(DCRAW_PATH ? rawInput : [])].sort());
  assert.deepEqual(capabilities.groups.document.experimentalInputs, ["wpd", "wps", "wpt"]);
  assert.deepEqual(capabilities.groups.spreadsheet.experimentalInputs, ["et", "ett"]);
  assert.deepEqual(capabilities.groups.presentation.experimentalInputs, ["dps", "dpt"]);
  assert.deepEqual(capabilities.groups.audio.experimentalInputs, ["kgg", "mflac", "kwm"]);
  assert.deepEqual(capabilities.groups.audio.inputs, ["aac", "flac", "kgg", "kgma", "kwm", "m4a", "mflac", "mgg", "mmp4", "mp3", "ncm", "ogg", "opus", "wav", "wma"]);
  const serverSource = require("node:fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const imageSource = require("node:fs").readFileSync(path.join(__dirname, "..", "image.js"), "utf8");
  const pdfTableSource = require("node:fs").readFileSync(path.join(__dirname, "..", "pdf-table.js"), "utf8");
  assert.doesNotMatch(serverSource, /limitInputPixels\s*:\s*false/);
  assert.match(imageSource, /assertImagePdfBudget\(metadataList\)/);
  assert.match(pdfTableSource, /assertPdfPages\(pdf\.numPages\)/);
  assert.match(pdfTableSource, /"-cropbox"/);
  assert.match(pdfTableSource, /async function\* pages\(\)/);
});

test("platform capabilities report os and arch only (no music-platform capability flags)", () => {
  assert.deepEqual(platformCapabilities("darwin", "arm64"), {
    os: "darwin", arch: "arm64"
  });
  assert.deepEqual(platformCapabilities("win32", "x64"), {
    os: "win32", arch: "x64"
  });
});

test("special audio formats are registered and expose audio targets outside Store mode", () => {
  const hadWindowsStore = Object.prototype.hasOwnProperty.call(process, "windowsStore");
  const previous = process.windowsStore;
  process.windowsStore = false;
  try {
    for (const extension of SPECIAL_AUDIO_EXTENSIONS) {
      assert.equal(audioInput.has(extension), true, `${extension} is missing from audioInput`);
      assert.equal(unlockAudioInputs.has(extension), true, `${extension} is missing from unlockAudioInputs`);
      assert.equal(categoryForExt(extension), "audio");
      assert.deepEqual(targetsForExt(extension, { ffmpeg: true }), [...mediaAudioTargets]);
    }
  } finally {
    if (hadWindowsStore) process.windowsStore = previous;
    else delete process.windowsStore;
  }
});

test("createServerUploadStorage rejects oversized special audio once and removes the partial file", async () => {
  assert.equal(MAX_SPECIAL_AUDIO_BYTES, 512 * 1024 * 1024);
  const storage = createServerUploadStorage({ specialMaxBytes: 4, defaultMaxBytes: 16 });
  const req = {};
  const file = {
    originalname: "oversized.ncm",
    stream: Readable.from([Buffer.alloc(3, 0x11), Buffer.alloc(3, 0x22)])
  };
  let callbackCount = 0;
  const result = await new Promise((resolve) => {
    storage._handleFile(req, file, (error, info) => {
      callbackCount += 1;
      resolve({ error, info });
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(callbackCount, 1);
  assert.equal(result.info, undefined);
  assert.equal(result.error.name, "MulterError");
  assert.equal(result.error.code, "LIMIT_FILE_SIZE");
  assert.equal(result.error.errorCode, "AUDIO_FILE_TOO_LARGE");
  assert.equal(result.error.limit, 4);
  assert.equal(req.specialAudioInputExt, "ncm");
  await assert.rejects(fs.access(file.path), (error) => error.code === "ENOENT");
});

test("truncated NCM input returns its format error instead of a Node range error", async () => {
  const { response, body } = await convertResponse("truncated.ncm", Buffer.from("CTENFDAM"), "mp3", "application/octet-stream");
  assert.equal(response.status, 422);
  assert.equal(body.errorCode, "NCM_CONVERSION_FAILED");
  assert.equal(body.sourceErrorCode, "NCM_SOURCE_FAILED");
  assert.doesNotMatch(body.error, /ERR_OUT_OF_RANGE|offset/i);
});

test("special format errors are mapped before storage field validation", async () => {
  const form = new FormData();
  form.append("wrong", new Blob([Buffer.from("bad")]), "bad.ncm");
  form.append("targetFormat", "mp3");
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.errorCode, "NCM_CONVERSION_FAILED");
  assert.equal(body.sourceErrorCode, "UNEXPECTED_FILE_FIELD");
});

test("ordinary upload field errors return a client status", async () => {
  const form = new FormData();
  form.append("wrong", new Blob([Buffer.from("bad")]), "bad.txt");
  form.append("targetFormat", "md");
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "UNEXPECTED_FILE_FIELD");
  assert.equal(body.sourceErrorCode, "LIMIT_UNEXPECTED_FILE");
});

test("Store mode hides and rejects every special audio format", async () => {
  const hadWindowsStore = Object.prototype.hasOwnProperty.call(process, "windowsStore");
  const previous = process.windowsStore;
  process.windowsStore = true;
  try {
    const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json();
    assert.deepEqual(capabilities.groups.audio.experimentalInputs, []);
    assert.equal(capabilities.groups.audio.inputs.includes("mp3"), true);
    for (const extension of SPECIAL_AUDIO_EXTENSIONS) {
      assert.equal(capabilities.groups.audio.inputs.includes(extension), false);
      assert.deepEqual(targetsForExt(extension, { ffmpeg: true }), []);

      const targetResponse = await fetch(`${baseUrl}/api/targets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension })
      });
      const targetBody = await targetResponse.json();
      assert.equal(targetResponse.status, 200);
      assert.deepEqual(targetBody.targets, []);

      const conversion = await convertResponse(
        `sample.${extension}`,
        Buffer.from("test"),
        "mp3",
        "application/octet-stream"
      );
      assert.equal(conversion.response.status, 400);
      assert.equal(conversion.body.errorCode, `${extension.toUpperCase()}_CONVERSION_FAILED`);
      assert.equal(conversion.body.sourceErrorCode, "AUDIO_UNLOCK_UNAVAILABLE_ON_STORE");
    }
    assert.ok(targetsForExt("mp3", { ffmpeg: true }).includes("wav"));
  } finally {
    if (hadWindowsStore) process.windowsStore = previous;
    else delete process.windowsStore;
  }
});

test("packaging and Win7 staging include the new runtime modules", () => {
  const packageJson = require("../package.json");
  const source = require("node:fs").readFileSync(path.join(__dirname, "..", "win7-build-profile.js"), "utf8");
  assert.ok(packageJson.build.files.includes("pdf-classifier.js"), "pdf-classifier.js is missing from build.files");
  for (const file of ["resource-policy.js", "text-conversion.js", "text-encoding.js", "pdf-table-extractor.js", "pdf-table-runtime.js", "audio-format-utils.js", "ncm-format.js", "ncm-metadata.js", "av3a-format.js", "kgg-format.js", "mflac-format.js", "kgma-format.js", "kwm-format.js", "config.js", "utils.js", "media.js", "zip-util.js", "image.js", "ocr.js", "pdfjs.js", "pdf-table.js", "pdf.js", "text-docx.js", "office-convert.js"]) {
    assert.ok(packageJson.build.files.includes(file), `${file} is missing from build.files`);
    assert.match(source, new RegExp(`["]${file.replace(".", "\\.")}["]`));
  }
});
