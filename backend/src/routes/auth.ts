import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { signToken, authMiddleware, requireRole } from '../middleware/auth.js';
import type { AuthenticatedRequest, JwtPayload } from '../middleware/auth.js';

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

// Helper: get client IP from common proxy headers, fallback to req.ip
function getClientIp(req: Request): string | null {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  const realIp = req.headers['x-real-ip'] as string | undefined;
  const ip = forwarded || realIp || req.ip || '';
  return ip || null;
}

// Helper: shape the user object we return to clients (never include password)
function shapeUser(user: {
  id: string;
  username: string;
  email: string;
  role: string;
  active: boolean;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    active: user.active,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    lastLoginIp: user.lastLoginIp ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !user.active) {
      // Same error for "not found" and "inactive" — avoid user enumeration
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const payload: JwtPayload = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };

    const token = signToken(payload);
    const ip = getClientIp(req);

    // Record last login (best-effort — do not fail the login if this errors)
    prisma.user
      .update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ip },
      })
      .catch((err) => console.error('Failed to record lastLoginAt:', err));

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register (Admin only)
authRouter.post('/register', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    // Username validation: 3-32 chars, alphanumeric + dash/underscore/dot
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      res.status(400).json({ error: 'Username must be 3-32 chars (letters, digits, dot, dash, underscore)' });
      return;
    }

    // Email validation: basic shape
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }

    // Password policy (matches frontend rules)
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      res.status(400).json({ error: 'Password must contain upper, lower, and a digit' });
      return;
    }

    const validRoles = ['ADMIN', 'OPERATOR', 'VIEWER'];
    if (role && !validRoles.includes(role)) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });

    if (existing) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashed,
        role: (role as 'ADMIN' | 'OPERATOR' | 'VIEWER') || 'OPERATOR',
      },
    });

    res.status(201).json({ user: shapeUser(user) });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me - Get current user
authRouter.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        active: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
      },
    });

    if (!user || !user.active) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: shapeUser(user) });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/password - Change password (self)
authRouter.put('/password', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new password are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      res.status(400).json({ error: 'Password must contain upper, lower, and a digit' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, user.password);

    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
      },
    });

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/users (Admin only)
authRouter.get('/users', authMiddleware, requireRole('ADMIN'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        active: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ users: users.map(shapeUser) });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/auth/users/:id (Admin only) — update role or active
authRouter.patch('/users/:id', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const { role, active } = req.body;

    if (id === req.user!.userId && active === false) {
      res.status(400).json({ error: 'Cannot deactivate your own account' });
      return;
    }

    if (id === req.user!.userId && role && role !== 'ADMIN') {
      res.status(400).json({ error: 'Cannot demote your own account' });
      return;
    }

    const data: Record<string, unknown> = {};
    if (role !== undefined) {
      const validRoles = ['ADMIN', 'OPERATOR', 'VIEWER'];
      if (!validRoles.includes(role)) {
        res.status(400).json({ error: 'Invalid role' });
        return;
      }
      data.role = role;
    }
    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        res.status(400).json({ error: 'active must be boolean' });
        return;
      }
      data.active = active;
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        active: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
      },
    });

    res.json({ user: shapeUser(user) });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/users/:id/reset-password (Admin only) — set temp password, force change on next login
authRouter.post('/users/:id/reset-password', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const { newPassword } = req.body;

    if (!newPassword) {
      res.status(400).json({ error: 'New password is required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      res.status(400).json({ error: 'Password must contain upper, lower, and a digit' });
      return;
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await prisma.user.update({
      where: { id },
      data: {
        password: hashed,
      },
    });

    res.json({ message: 'Password reset successfully.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/users/:id (Admin only)
authRouter.delete('/users/:id', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);

    if (id === req.user!.userId) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    await prisma.user.delete({ where: { id } });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
