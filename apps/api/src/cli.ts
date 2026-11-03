/**
 * Operator CLI (run inside the api container):
 *   node apps/api/dist/cli.js bootstrap-token
 *   VS_PASSWORD=... node apps/api/dist/cli.js create-user <email> <owner|editor|viewer>
 *   VS_PASSWORD=... node apps/api/dist/cli.js reset-password <email>
 *   node apps/api/dist/cli.js reset-totp <email>
 */
import { createDatabase, migrate, newId, audit } from '@vs/core';
import { ROLES, type Role } from '@vs/shared';
import { ensureBootstrapToken } from './lib/bootstrap.js';
import { hashPassword } from './lib/password.js';

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is required');
const [cmd, ...args] = process.argv.slice(2);
const database = createDatabase(url, { max: 1 });
const sql = database.sql;
await migrate(sql);

const password = () => {
  const p = process.env.VS_PASSWORD;
  if (!p || p.length < 12) fail('set VS_PASSWORD (min 12 characters)');
  return p;
};

try {
  switch (cmd) {
    case 'bootstrap-token': {
      const token = await ensureBootstrapToken(sql);
      if (!token) fail('admin users already exist; bootstrap is closed');
      process.stdout.write(`${token}\n`);
      break;
    }
    case 'create-user': {
      const [email, role] = args;
      if (!email || !role || !ROLES.includes(role as Role))
        fail('usage: create-user <email> <owner|editor|viewer>');
      const id = newId();
      await sql`INSERT INTO admin_users (id, email, password_hash, role) VALUES (${id}, ${email}, ${await hashPassword(password())}, ${role})`;
      await audit(sql, {
        actorLabel: 'cli',
        action: 'user.create',
        entity: 'admin_user',
        entityId: id,
        diff: { email, role },
      });
      process.stdout.write(`${id}\n`);
      break;
    }
    case 'reset-password': {
      const [email] = args;
      const r =
        await sql`UPDATE admin_users SET password_hash = ${await hashPassword(password())}, failed_logins = 0, locked_until = NULL
                          WHERE lower(email) = lower(${email ?? ''}) AND deleted_at IS NULL RETURNING id`;
      if (!r.length) fail('no such user');
      await sql`DELETE FROM admin_sessions WHERE user_id = ${r[0]!.id as string}`;
      await audit(sql, {
        actorLabel: 'cli',
        action: 'user.reset_password',
        entity: 'admin_user',
        entityId: r[0]!.id as string,
      });
      break;
    }
    case 'reset-totp': {
      const [email] = args;
      const r =
        await sql`UPDATE admin_users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL
                          WHERE lower(email) = lower(${email ?? ''}) AND deleted_at IS NULL RETURNING id`;
      if (!r.length) fail('no such user');
      await sql`DELETE FROM admin_sessions WHERE user_id = ${r[0]!.id as string}`;
      await audit(sql, {
        actorLabel: 'cli',
        action: 'user.reset_totp',
        entity: 'admin_user',
        entityId: r[0]!.id as string,
      });
      break;
    }
    default:
      fail(
        'commands: bootstrap-token | create-user <email> <role> | reset-password <email> | reset-totp <email>',
      );
  }
} finally {
  await database.close();
}
