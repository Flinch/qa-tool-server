import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import projectsRouter from './routes/projects.js'
import testCasesRouter from './routes/testCases.js'
import { patchTestCase } from './routes/testCases.js'
import requirementsRouter from './routes/requirements.js'
import { patchRequirement } from './routes/requirements.js'
import bugsRouter from './routes/bugs.js'
import { patchBug } from './routes/bugs.js'
import statsRouter from './routes/stats.js'
import authRouter from './routes/auth.js'
import automationRouter from './routes/automation.js'
import executionRunsRouter from './routes/executionRuns.js'
import webhooksRouter from './routes/webhooks.js'
import { requireAuth, requireRole } from './middleware/auth.js'

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
app.use('/api/projects/:id/automation', automationRouter)
app.use('/api/projects/:id/execution-runs', executionRunsRouter)
app.use('/api/stats', statsRouter)
app.use('/api/webhooks', webhooksRouter)

// Standalone PATCH routes
app.patch('/api/test-cases/:id', requireAuth, requireRole('qa_engineer', 'admin'), patchTestCase)
app.patch('/api/requirements/:id', requireAuth, requireRole('qa_engineer', 'admin'), patchRequirement)
app.patch('/api/bugs/:id', requireAuth, requireRole('qa_engineer', 'admin'), patchBug)

app.listen(PORT, () => console.log(`QA Tool server running on port ${PORT}`))