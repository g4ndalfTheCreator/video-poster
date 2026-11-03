/**
 * Starts PostgreSQL 16 with Testcontainers (or uses TEST_DATABASE_URL) and builds a migrated
 * template database. Each test file clones it via `createTestDatabase()`.
 */
export default function setup({
  provide,
}: {
  provide: (k: string, v: string) => void;
}): Promise<() => Promise<void>>;
export declare function withDb(url: string, db: string): string;
//# sourceMappingURL=global-setup.d.ts.map
