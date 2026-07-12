// `pdf-parse` was tried first and rejected on both major versions:
// - v2 pulls in pdfjs-dist's "legacy" build, which needs browser globals
//   (DOMMatrix, etc.) and crashed the whole server process at import time on
//   Railway's Node runtime (its own polyfill depends on
//   process.getBuiltinModule, not available there).
// - v1's bundled pdf.js is from ~2017 and choked with "bad XRef entry" on a
//   completely standard PDF 1.4 file (a plain reportlab-generated PDF, not
//   an edge case) — too fragile to trust with arbitrary real-world PDFs.
// `unpdf` ships its own serverless-optimized PDF.js build made specifically
// for Node/edge runtimes without browser globals, and is actively
// maintained — no equivalent workaround needed.
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'

// Text-based PDFs only — no OCR, so a scanned/image PDF will extract
// nothing. Most PRDs exported from Docs/Notion/Word are text-based, so this
// is an acceptable v1 limitation rather than a real gap.
async function extractPdfText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

export async function extractDocumentText({ filename, mimetype, data }) {
  const buffer = Buffer.from(data, 'base64')
  const ext = (filename || '').split('.').pop()?.toLowerCase()

  if (mimetype === 'application/pdf' || ext === 'pdf') {
    return extractPdfText(buffer)
  }
  if (mimetype?.includes('officedocument.wordprocessingml') || ext === 'docx') {
    return extractDocxText(buffer)
  }
  // .txt, .md, or anything else unrecognized — treat as plain text.
  return buffer.toString('utf-8')
}
