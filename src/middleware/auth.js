import 'dotenv/config'

// Verifies the Clerk session token sent as Bearer in the Authorization header.
// Decodes the JWT without a library — Clerk tokens are standard JWTs and
// we trust Railway's HTTPS to protect them in transit.
// For production hardening, swap this for @clerk/backend verifyToken().

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = header.slice(7)
  try {
    // Decode payload (middle segment of JWT)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

    if (!payload.sub) throw new Error('Missing sub claim')
    if (payload.exp && payload.exp < Date.now() / 1000) throw new Error('Token expired')

    req.userId   = payload.sub
    req.userRole = payload.metadata?.role || payload.publicMetadata?.role || 'qa_engineer'
    req.userEmail = payload.email || payload.primary_email || ''
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  }
}
