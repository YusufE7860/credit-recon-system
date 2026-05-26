/**
 * Emergency recovery script — creates or reactivates an ADMIN user.
 *
 * Use this when you're locked out of the app (no admin in the DB, or
 * the only admin got deactivated). Run it with:
 *
 *   cd backend/api
 *   npx ts-node scripts/create-admin.ts "Your Name" your@email.com YourPassword
 *
 * Behavior:
 *  - If a user with that email exists: reactivates, promotes to ADMIN,
 *    and resets the password to the one you provided.
 *  - If they don't exist: creates a fresh ADMIN user.
 *
 * Safe to run repeatedly — idempotent on the email field.
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  const [, , name, email, password] = process.argv;

  if (!name || !email || !password) {
    console.error('Usage: npx ts-node scripts/create-admin.ts "Name" email@addr password');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const hashed = await bcrypt.hash(password, 10);

    // upsert: create-if-missing, update-if-present.
    const user = await prisma.user.upsert({
      where: { email },
      update: {
        name,
        password: hashed,
        role: Role.ADMIN,
        active: true,
      },
      create: {
        name,
        email,
        password: hashed,
        role: Role.ADMIN,
        active: true,
      },
    });

    console.log('');
    console.log('✓ Admin user ready');
    console.log('  id:    ' + user.id);
    console.log('  email: ' + user.email);
    console.log('  role:  ' + user.role);
    console.log('');
    console.log('Log in at http://localhost:3001/login');
  } catch (err) {
    console.error('Failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
