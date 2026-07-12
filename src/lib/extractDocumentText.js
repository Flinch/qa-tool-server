import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'

// Text-based PDFs only — no OCR, so a scanned/image PDF will extract
// nothing. Most PRDs exported from Docs/Notion/Word are text-based, so this
// is an acceptable v1 limitation rather than a real gap.
async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return result.text
  } finally {
    await parser.destroy()
  }
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
