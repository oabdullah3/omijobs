/**
 * Minimal ambient types for node:sqlite (built into Node >= 24).
 *
 * This project's @types/node is pinned to v20, which predates node:sqlite, so
 * its module declarations don't exist yet. This shim covers only the surface
 * db.ts uses. When @types/node is bumped to >= 22.6, delete this file.
 */
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }
}
