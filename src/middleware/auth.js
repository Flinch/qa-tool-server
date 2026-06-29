export async function requireAuth(req, res, next) {
  req.userId = 'test-user'
  req.userRole = 'qa_engineer'
  req.userEmail = 'malik@test.com'
  next()
}

export function requireRole(...roles) {
  return (req, res, next) => next()
}