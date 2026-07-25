// Builds a single, fully self-contained HTML report (no external CDN deps,
// unlike Maestro's own --format HTML-DETAILED) from data report-mobile-
// results.js already has in memory after one `maestro test` run — no second
// test execution needed just to get a report, which would double device
// time and double exposure to the same driver flakiness this whole mobile
// initiative has been fighting.
function escapeHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const STATUS_COLOR = { passed: '#3a9c6f', failed: '#c1443a', skipped: '#a08a2f' }

function resultRow(r) {
  const color = STATUS_COLOR[r.status] || '#888'
  const duration = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'
  return `
    <div class="row">
      <div class="row-head">
        <span class="status" style="color:${color};border-color:${color}">${r.status}</span>
        <span class="title">${escapeHtml(r.test_title)}</span>
        <span class="duration">${duration}</span>
      </div>
      ${r.error_message ? `<div class="error">${escapeHtml(r.error_message)}</div>` : ''}
      ${r.screenshot_base64 ? `<img class="screenshot" src="data:image/png;base64,${r.screenshot_base64}" alt="Failure screenshot for ${escapeHtml(r.test_title)}" />` : ''}
    </div>`
}

export function buildHtmlReport({ suiteSlug, platform, results, startedAt = new Date() }) {
  const total = results.length
  const passed = results.filter(r => r.status === 'passed').length
  const failed = results.filter(r => r.status === 'failed').length
  const skipped = results.filter(r => r.status === 'skipped').length

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(suiteSlug)} — Maestro report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #17171a; color: #e6e6e6; margin: 0; padding: 2.5rem 1.5rem; }
  .wrap { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 1.2rem; margin: 0 0 0.25rem; }
  .meta { color: #999; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .summary { display: flex; gap: 1.5rem; margin-bottom: 2rem; font-size: 0.85rem; }
  .summary b { font-size: 1.3rem; display: block; }
  .row { border: 1px solid #333; border-radius: 4px; padding: 0.9rem 1rem; margin-bottom: 0.6rem; }
  .row-head { display: flex; align-items: center; gap: 0.7rem; }
  .status { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid; border-radius: 3px; padding: 0.1rem 0.5rem; }
  .title { font-weight: 600; flex: 1; }
  .duration { color: #999; font-size: 0.8rem; }
  .error { margin-top: 0.5rem; font-size: 0.82rem; color: #e08a80; white-space: pre-wrap; }
  .screenshot { margin-top: 0.75rem; max-width: 100%; border: 1px solid #333; border-radius: 4px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(suiteSlug)}</h1>
    <div class="meta">${escapeHtml(platform)} · ${startedAt.toISOString()}</div>
    <div class="summary">
      <div><b>${total}</b>total</div>
      <div style="color:${STATUS_COLOR.passed}"><b>${passed}</b>passed</div>
      <div style="color:${STATUS_COLOR.failed}"><b>${failed}</b>failed</div>
      <div style="color:${STATUS_COLOR.skipped}"><b>${skipped}</b>skipped</div>
    </div>
    ${results.map(resultRow).join('\n')}
  </div>
</body>
</html>`
}
