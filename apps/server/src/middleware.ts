import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { User } from '@devicefarmz/core'
import { verifyToken } from './auth.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User
    }
  }
}

/** Bearer token, Basic auth (password = token) or ?token= */
export function userFromRequest(req: Request): User | null {
  const header = req.headers.authorization
  let token: string | undefined
  if (header?.startsWith('Bearer ')) token = header.slice(7).trim()
  else if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    token = decoded.slice(decoded.indexOf(':') + 1)
  } else if (typeof req.query.token === 'string') token = req.query.token
  return token ? verifyToken(token) : null
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = userFromRequest(req)
  if (!user) {
    res.status(401).json({ error: 'Missing or invalid token' })
    return
  }
  req.user = user
  next()
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin required' })
    return
  }
  next()
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>

/** Express 4 does not catch rejected promises; this forwards them to the error handler */
export function wrap(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
  }
}
