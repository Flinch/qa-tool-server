import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import projectsRouter from './routes/projects.js'
import testCasesRouter from './routes/testCases.js'
import requirementsRouter from './routes/requirements.js'
import bugsRouter from './routes/bugs.js'
import featuresRouter from './routes/features.js'
import statsRouter from './routes/stats.js'
import authRouter from './routes/auth.js'
import automationRouter from './routes/automation.js'
import executionRunsRouter from './routes/executionRuns.js'
import webhooksRouter from './routes/webhooks.js'
import { startNightlyScheduler } from './lib/nightlyScheduler.js'

const app = express()
const PORT = process.env.PORT || 3002
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

// Raised from the default 100kb so bug-comment screenshots (base64-encoded,
// no object storage configured for this app) fit in the request body.
app.use(express.json({ limit: '8mb' }))

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Routes
app.use('/api/auth', authRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/projects/:id/test-cases', testCasesRouter)
app.use('/api/projects/:id/requirements', requirementsRouter)
app.use('/api/projects/:id/bugs', bugsRouter)
app.use('/api/projects/:id/features', featuresRouter)
app.use('/api/projects/:id/automation', automationRouter)
app.use('/api/projects/:id/execution-runs', executionRunsRouter)
app.use('/api/stats', statsRouter)
app.use('/api/webhooks', webhooksRouter)

// Phase A: the old standalone /api/test-cases/:id, /api/requirements/:id,
// /api/bugs/:id, /api/features/:id PATCH/DELETE routes are gone — they had
// no project/tenant id in their URL, so once a tenant's data lives in its
// own database there was no way to know which one to open. Their handlers
// now live nested inside their respective routers above (e.g.
// PATCH /api/projects/:id/test-cases/:tcId), where requireTenantAccess
// already resolves req.db before the handler runs.

app.listen(PORT, () => console.log(`QA Tool server running on port ${PORT}`))

// Phase A, Part 6: nightly suite runs are dispatched by this server now,
// not GitHub Actions' own schedule: trigger (retired from playwright.yml /
// maestro-run.yml) — see nightlyScheduler.js for why.
startNightlyScheduler()