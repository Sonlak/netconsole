import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { signToken, authMiddleware, requireRole } from '../middleware/auth.js';
import type { AuthenticatedRequest, JwtPayload } from '../middleware/auth.js';

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

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

    res.json({
      token,
      mustChangePassword: user.mustChangePassword,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register (Admin only in production)
authRouter.post('/register', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
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
        role: role || 'OPERATOR',
      },
    });

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
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
      select: { id: true, username: true, email: true, role: true, active: true, mustChangePassword: true, createdAt: true },
    });

    if (!user || !user.active) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/password - Change password
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
        mustChangePassword: false,
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
      select: { id: true, username: true, email: true, role: true, active: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ users });
  } catch (error) {
    console.error('List users error:', error);
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
