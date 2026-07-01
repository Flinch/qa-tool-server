import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const JWT_SECRET = process.env.JWT_SECRET
const TOKEN_EXPIRY = '7d'

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  )
}

// POST /api/auth/register
// Public signup. Always creates a "client" account — qa_engineer accounts
// are provisioned manually by flipping the role column after signup.
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password, and name are required' })
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const id = crypto.randomUUID()

    const { rows } = await query(
      `INSERT INTO users (id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'client')
       RETURNING id, email, name, role, created_at`,
      [id, email.toLowerCase(), passwordHash, name]
    )

    const user = rows[0]
    const token = signToken(user)

    res.status(201).json({ token, user })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' })
    }

    const { rows } = await query(
      'SELECT id, email, password_hash, name, role FROM users WHERE email = $1',
      [email.toLowerCase()]
    )

    if (rows.length === 0 || !rows[0].password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = rows[0]
    const valid = await bcrypt.compare(password, user.password_hash)

    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const token = signToken(user)
    const { password_hash, ...safeUser } = user

    res.json({ token, user: safeUser })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/auth/me
// Used by the client on page load to validate an existing token and
// rehydrate user state without forcing a re-login.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, email, name, role, created_at FROM users WHERE id = $1',
      [req.userId]
    )
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }
    res.json({ user: rows[0] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
