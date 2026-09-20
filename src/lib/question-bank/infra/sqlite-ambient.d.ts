/**
 * node:sqlite 最小环境声明
 *
 * 项目 @types/node 为 20.x，未包含 node:sqlite（Node 22.5+ 内置模块）类型。
 * 此处仅声明本引擎实际使用到的最小 API 面，避免引入新的外部依赖。
 * 运行时由 Node >= 22.13（无 flag）提供；当前环境 Node 24。
 */
declare module "node:sqlite" {
  export interface StatementSyncBindValue {
    [key: string]: unknown;
  }

  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export interface DatabaseSyncOpenOptions {
    readOnly?: boolean;
    readWrite?: boolean;
  }

  export class DatabaseSync {
    constructor(filename: string, options?: DatabaseSyncOpenOptions);
    exec(sql: string): this;
    prepare(sql: string): StatementSync;
    close(): void;
    [Symbol.dispose](): void;
  }
}
