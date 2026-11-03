import { type Config, type Database } from '../packages/core/src/index.js';
declare module 'vitest' {
  interface ProvidedContext {
    pgAdminUrl: string;
  }
}
/** Creates a fresh database cloned from the migrated template. */
export declare function createTestDatabase(): Promise<{
  database: Database;
  url: string;
  drop: () => Promise<void>;
}>;
export declare function testConfig(overrides?: Record<string, string>): Config;
//# sourceMappingURL=helpers.d.ts.map
