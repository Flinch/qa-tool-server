import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = verifyToken(token)
    req.userId = decoded.sub
    req.userEmail = decoded.email
    req.userRole = decoded.role
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      return res.status(403).json({ error: "You don't have access to this resource" })
    }
    next()
  }
}