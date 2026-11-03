import { hash, verify } from '@node-rs/argon2';

// Argon2id, m=64 MiB, t=3, p=1 (Algorithm.Argon2id = 2; const enum not importable with isolatedModules)
const OPTIONS = { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/** A precomputed hash used to keep response times uniform when the user does not exist. */
let dummy: Promise<string> | undefined;
export async function dummyVerify(password: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, password);
}
