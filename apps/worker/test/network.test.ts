import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import { makeApp, type TestApp } from '../../api/test/support.js';
import { defaultResolver, enrichIp } from '../src/ipintel/enrich.js';

/** Real RDAP + PTR lookups for a public test IP. Opt-in: RUN_NETWORK_TESTS=1 (needs internet + DNS). */
describe.runIf(process.env.RUN_NETWORK_TESTS === '1')('ip enrichment (network)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('caches RDAP owner and PTR for a public IP', async () => {
    const ip = process.env.NETWORK_TEST_IP ?? '193.166.3.2'; // ftp.funet.fi (FUNET, Finland)
    const deps = {
      sql: t.ctx.database.sql,
      config: t.ctx.config,
      log: pino({ level: 'silent' }),
      resolver: defaultResolver(t.ctx.config),
    };
    const id = await enrichIp(deps, ip);
    const row = (await t.ctx.database.sql`SELECT * FROM ip_intel WHERE id = ${id}`)[0]!;
    expect(row.rdap_netname ?? row.rdap_org).toBeTruthy();
    expect(row.rdap_cidr).toMatch(/\/\d+$/);
    expect(row.ptr).toBeTruthy();
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
  }, 60_000);
});
