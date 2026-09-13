import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// List terminal sessions (with pagination)
router.get('/', async (req: AuthenticatedRequest, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const deviceId = req.query.deviceId as string | undefined;

  const where: any = {};
  if (deviceId) where.deviceId = deviceId;

  const [sessions, total] = await Promise.all([
    prisma.terminalSession.findMany({
      where,
      orderBy: { startTime: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        deviceId: true,
        deviceIp: true,
        deviceName: true,
        hostname: true,
        startTime: true,
        endTime: true,
        error: true,
        user: { select: { username: true, role: true } },
        _count: { select: { commands: true } },
      },
    }),
    prisma.terminalSession.count({ where }),
  ]);

  res.json({ sessions, total, page, limit });
});

// Get session details with commands
router.get('/:id', async (req: AuthenticatedRequest, res) => {
  const id = req.params.id as string;
  const session = await prisma.terminalSession.findUnique({
    where: { id },
    include: {
      user: { select: { username: true, role: true } },
      commands: { orderBy: { timestamp: 'asc' } },
    },
  });

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(session);
});

// Delete session (admin only)
router.delete('/:id', async (req: AuthenticatedRequest, res) => {
  const id = req.params.id as string;
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin only' });
    return;
  }

  await prisma.terminalCommand.deleteMany({ where: { sessionId: id } });
  await prisma.terminalSession.delete({ where: { id } });

  res.json({ success: true });
});

export const terminalRouter = router;
