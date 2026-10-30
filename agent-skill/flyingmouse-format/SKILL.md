---
name: flyingmouse-format
description: Use FlyingMouse Format's local offline CLI to inspect supported conversions and convert images, text, documents, spreadsheets, presentations, PDFs, subtitles, archives, audio, and video. Trigger when a user asks to convert file formats, extract text with OCR, merge images into PDF, merge PDFs, inspect available target formats, or automate these operations from an agent.
---

# FlyingMouse Format

Use the bundled wrapper at `scripts/flyingmouse-format.js`. It locates the FlyingMouse Format application configured by the in-app “Connect to Agent” action and invokes its CLI.

## Workflow

1. Check available targets before an unfamiliar conversion:

   `node scripts/flyingmouse-format.js targets <file> --json`

2. Convert one or more independent files:

   `node scripts/flyingmouse-format.js convert <files...> --to <format> --output-dir <directory> --json`

3. Merge images into one PDF:

   `node scripts/flyingmouse-format.js images-to-pdf <images...> --output <result.pdf> --json`

4. Merge PDFs:

   `node scripts/flyingmouse-format.js merge-pdfs <pdfs...> --output <result.pdf> --json`

5. Inspect the connected application's engines and limits:

   `node scripts/flyingmouse-format.js capabilities --json`

   Use `toolDetails.libreoffice.status` and `toolDetails.pdfStructure` when available. Office preparation may be pending while other conversions remain available; the Lite edition omits the advanced scanned-table engine. Check runtime targets and limits before selecting a conversion, because the connected application may be an older installation.

## Conversion expectations

- When the connected app exposes these targets, SRT, VTT, ASS and SSA can convert between each other or export TXT; images can use OCR to create DOCX or Markdown, and PDFs can export Markdown.
- Image OCR outputs editable text. PDF Markdown may retain simple headings and tables, but these outputs do not guarantee the original layout or illustrations. Multi-page TIFF OCR processes each page; animated image input uses the first frame and returns a warning.
- Read `outputs[].warnings` alongside `outputs[].path` and communicate review, layout, subtitle-style or timing-loss warnings to the user. Do not describe a successful output with warnings as a verified exact reproduction.
- With `--json`, conversion failures are reported on stderr with a nonzero exit code. Preserve `errorCode` for diagnosis; do not hide low OCR confidence, missing-engine or resource-limit errors with an unverified success claim.

## Options

- Video: `--video-codec h264|h265|av1`
- PDF: `--pdf-action encrypt|decrypt --password <password>`
- Prefer `--json` and read `outputs[].path` from stdout.
- Never echo or log a PDF password.
- Preserve the user's requested output directory and do not overwrite existing files without permission.

If the wrapper reports that FlyingMouse Format is missing, ask the user to open the application and use “Connect to Agent” again.
