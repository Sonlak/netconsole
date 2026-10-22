/**
 * bootstrap-admin.mjs — create the first ADMIN user on a fresh database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The production database was deployed empty: the `User` table had ZERO
 * rows, so every login attempt returned 401 "Invalid credentials" no
 * matter what password was used. The prisma seed (`prisma/seed.ts`) also
 * creates demo DEVICES, which we do not want on a production box, and it
 * refuses to be re-run cleanly. This script only creates the admin user.
 *
 * It is idempotent:
 *   - user already exists       -> no-op
 *   - an ADMIN already exists    -> no-op (never creates a second admin)
 *   - no ADMIN, no user          -> creates the admin
 *
 * Usage (inside the backend container):
 *   docker exec netconsole-backend node scripts/bootstrap-admin.mjs
 *
 * Environment:
 *   SEED_ADMIN_USERNAME   default "admin"
 *   SEED_ADMIN_PASSWORD   default "Admin@123" (see warning below)
 *   SEED_ADMIN_EMAIL      default "admin@netconsole.local"
 *   SEED_ADMIN_MUST_CHANGE_PASSWORD
 *                         default "false" — the frontend has no
 *                         mustChangePassword redirect wired up yet
 *                         (see docs/agents/05-gotchas.md #1), so a forced
 *                         rotation would just confuse the operator.
 *                         Set to "true" once the redirect exists.
 *
 * SECURITY NOTE
 * -------------
 * The default password is the well-known dev password. It exists so a
 * fresh production box is usable immediately. Rotate it via
 * POST /api/auth/change-password (or `scripts/rotate_secrets.sh`) and
 * set a strong SEED_ADMIN_PASSWORD in secrets.env — the deploy workflow
 * reads it from there and passes it in, so rotation needs no code change.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const username = process.env.SEED_ADMIN_USERNAME || 'admin';
const email = process.env.SEED_ADMIN_EMAIL || 'admin@netconsole.local';
const password = process.env.SEED_ADMIN_PASSWORD || 'Admin@123';
const mustChangePassword =
  (process.env.SEED_ADMIN_MUST_CHANGE_PASSWORD || 'false').toLowerCase() === 'true';
const BCRYPT_ROUNDS = 13;

if (!process.env.SEED_ADMIN_PASSWORD) {
  console.warn(
    '[bootstrap-admin] SEED_ADMIN_PASSWORD is not set - using the default dev password. ' +
      'Set it in secrets.env and re-run to rotate.',
  );
}

async function main() {
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(
      `[bootstrap-admin] user "${username}" already exists (id=${existing.id}, role=${existing.role}, active=${existing.active}) - nothing to do.`,
    );
    return;
  }

  const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
  if (adminCount > 0) {
    console.log(
      `[bootstrap-admin] an ADMIN already exists (${adminCount} total) - refusing to create a second bootstrap admin.`,
    );
    return;
  }

  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      username,
      email,
      password: hashed,
      role: 'ADMIN',
      active: true,
      mustChangePassword,
      passwordChangedAt: new Date(),
    },
  });

  console.log(`[bootstrap-admin] created ADMIN user "${user.username}" (id=${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
