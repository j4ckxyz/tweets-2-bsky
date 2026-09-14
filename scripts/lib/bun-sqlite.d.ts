// Minimal typing for Bun's built-in SQLite, so the node-typed typecheck understands it.
declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    query(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number };
    };
    transaction<T>(fn: () => T): () => T;
    close(): void;
  }
}
