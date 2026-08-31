import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

/**
 * Loose payload shape used by `verifyToken`. Workers may sign tokens that only
 * have `sub` + `role` (no `userId` / `username`), and we want to accept those.
 */
export interface JwtPayloadLoose {
  userId?: string;
  sub?: string;
  username?: string;
  role?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload | JwtPayloadLoose;
}

const JWT_SECRET: string = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '24h';

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}d`,
  });
}

export function verifyToken(token: string): JwtPayloadLoose | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayloadLoose;
    // Normalize: map `sub` -> `userId` so older / worker tokens still work
    if (!decoded.userId && decoded.sub) {
      decoded.userId = decoded.sub;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  req.user = payload;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!req.user.role || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      return;
    }

    next();
  };
}