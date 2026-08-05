// Drop-in replacement for @playwright/test's `test`/`expect`, used by
// API-engine generated specs (tests/generated/<suite>/tc-*.spec.ts) instead
// of importing from '@playwright/test' directly. Overrides the built-in
// `request` fixture with a Proxy that transparently records every HTTP call
// made during a test and attaches the trace as JSON when the test fails —
// mirroring how a failed web test already gets a screenshot captured
// (screenshot: 'only-on-failure' in playwright.config.js). Playwright's
// `request` fixture has no built-in request/response event hook the way
// page/BrowserContext has, so this builds the equivalent from scratch.
//
// Generated test code (`request.post(...)`, `request.get(...)`, etc.) needs
// zero changes — only the import line changes.
import { test as base, expect } from '@playwright/test'
import type { APIRequestContext, APIResponse } from '@playwright/test'

type TraceEntry = {
  method: string
  url: string
  requestHeaders: Record<string, string>
  requestBody: unknown
  status?: number
  responseHeaders?: Record<string, string>
  responseBody?: unknown
  error?: string
}

const TRACED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'])
const REDACT_HEADERS = new Set(['authorization', 'cookie', 'set-cookie'])

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v
  }
  return out
}

// Non-JSON/text bodies (a generated PDF/image download) get a placeholder
// instead of being dumped whole into a JSONB column and the webhook's 8mb
// payload budget (index.js's express.json limit).
async function safeReadBody(response: APIResponse) {
  const contentType = response.headers()['content-type'] || ''
  if (!/json|text|xml|html|javascript/i.test(contentType)) {
    return `[omitted: content-type ${contentType || 'unknown'}]`
  }
  try {
    return await response.json()
  } catch {
    try {
      const text = await response.text()
      return text.length > 20_000 ? text.slice(0, 20_000) + '…[truncated]' : text
    } catch {
      return null
    }
  }
}

function safeRequestBody(options: any) {
  if (options?.multipart) return '[multipart form data omitted]'
  return options?.data ?? options?.form ?? null
}

export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ request }, use, testInfo) => {
    const trace: TraceEntry[] = []

    const wrapped = new Proxy(request, {
      get(target, prop, receiver) {
        const value = (target as any)[prop]
        if (typeof value !== 'function') return value
        // Only special-case the traced HTTP verbs. Every other property
        // (dispose, storageState, etc.) must be bound back to the real
        // target, not left to execute with `this` = the Proxy — Playwright's
        // APIRequestContext is a ChannelOwner with private instance state,
        // and method-call `this` binding follows call-site syntax, not
        // whatever the trap returns.
        if (!TRACED_METHODS.has(prop as string)) return value.bind(target)

        return async (urlOrRequest: any, options?: any) => {
          const entry: TraceEntry = {
            method: String(prop).toUpperCase(),
            url: String(urlOrRequest),
            requestHeaders: redactHeaders(options?.headers),
            requestBody: safeRequestBody(options),
          }
          try {
            const response: APIResponse = await (target as any)[prop](urlOrRequest, options)
            entry.status = response.status()
            entry.responseHeaders = redactHeaders(response.headers())
            entry.responseBody = await safeReadBody(response)
            trace.push(entry)
            return response
          } catch (err) {
            // No response object exists at all (DNS/connection failure).
            // Still record it — this is often the actual root cause (a bad
            // setup call breaking a later assertion), not noise to drop.
            entry.error = err instanceof Error ? err.message : String(err)
            trace.push(entry)
            throw err
          }
        }
      },
    })

    await use(wrapped)

    if (testInfo.status !== 'passed' && testInfo.status !== 'skipped' && trace.length > 0) {
      await testInfo.attach('api-trace', {
        body: JSON.stringify(trace, null, 2),
        contentType: 'application/json',
      })
    }
  },
})

export { expect }
