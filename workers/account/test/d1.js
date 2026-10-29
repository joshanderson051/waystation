// ============================================================
// PORT SOLACE — a D1 stand-in for the tests: real SQLite through node:sqlite's DatabaseSync (Node 22.5+; Node 24
// ships it without a flag). Applies the migrations, then answers prepare(sql).bind(...).first()/all()/run()
// and batch([...]) (one transaction, like D1) with D1's result shapes. Not a test file itself (no .test.js).
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// node:sqlite still prints an ExperimentalWarning on some Node versions; keep the test output clean.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
  const text = String(warning && warning.message ? warning.message : warning);
  if ((type === 'ExperimentalWarning' || (warning && warning.name === 'ExperimentalWarning')) && /sqlite/i.test(text)) return;
  return emitWarning.call(this, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../migrations');

// D1 accepts null, numbers, strings, booleans and ArrayBuffers, and refuses undefined.
function bindValue(v) {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;
}
const plainRow = r => ({ ...r });                     // node:sqlite rows have a null prototype

export function d1(opts = {}) {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) db.exec(readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8'));
  const log = [];                                      // every statement run, with its params (for assertions)

  function exec(sql, params) {
    log.push({ sql, params });
    const stmt = db.prepare(sql);
    const reader = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (reader) {
      const rows = stmt.all(...params).map(plainRow);
      return { success: true, results: rows, meta: { changes: db.prepare('SELECT changes() AS c').get().c, rows_read: rows.length } };
    }
    const r = stmt.run(...params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...values) { return new Statement(this.sql, values.map(bindValue)); }
    async first(column) {
      const r = exec(this.sql, this.params);
      const row = r.results[0];
      if (!row) return null;
      return column == null ? row : row[column] === undefined ? null : row[column];
    }
    async all() { return exec(this.sql, this.params); }
    async run() { return exec(this.sql, this.params); }
    async raw() { return exec(this.sql, this.params).results.map(r => Object.values(r)); }
  }

  return {
    sqlite: db, log,
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      if (opts.failBatch) throw new Error('D1_ERROR: batch failed (test)');
      db.exec('BEGIN');
      try {
        const out = statements.map(s => exec(s.sql, s.params));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
  };
}
