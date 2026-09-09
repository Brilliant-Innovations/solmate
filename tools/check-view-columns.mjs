#!/usr/bin/env node
/**
 * `create or replace view` matches the existing view's columns **by position**. A column inserted in
 * the middle of a select list is therefore read as a rename of whatever sat at that ordinal, and
 * Postgres refuses the migration with 42P16 "cannot change name of view column".
 *
 * Every redefinition of a view must keep the previous definition's column list as a prefix and
 * append anything new at the end. This walks the migrations in order and checks exactly that, in a
 * second and without Docker. The database CI job catches it too, but only once Supabase has
 * started — and an operator applying to a hosted project by hand gets no warning at all until the
 * statement fails part way through, which is how this check came to exist (2026-09-09).
 *
 * Usage: node tools/check-view-columns.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
/** Output column names, in order, of every `create [or replace] view` in a migration file. */
function viewsIn(sql) {
  const out = new Map();
  const re = /create\s+(?:or\s+replace\s+)?view\s+([a-z_]+\.[a-z_]+)[\s\S]*?\bas\s*\n\s*select\b/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    // The select list ends at the first top-level `from`.
    const rest = sql.slice(re.lastIndex);
    let depth = 0;
    let end = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && /\s/.test(c) && /^from\s/i.test(rest.slice(i + 1))) {
        end = i + 1;
        break;
      }
    }
    const list = rest.slice(0, end);
    // Split on top-level commas, dropping comment lines.
    const items = [];
    let cur = '';
    depth = 0;
    for (const line of list.split('\n')) {
      const l = line.replace(/--.*$/, '');
      for (const c of l) {
        if (c === '(') depth++;
        else if (c === ')') depth--;
        if (c === ',' && depth === 0) {
          items.push(cur);
          cur = '';
        } else cur += c;
      }
      cur += ' ';
    }
    if (cur.trim()) items.push(cur);
    out.set(
      name,
      items
        .map((raw) => {
          const t = raw.trim().replace(/\s+/g, ' ');
          if (!t) return null;
          const alias = t.match(/ as ([a-z_][a-z0-9_]*)$/i);
          if (alias) return alias[1];
          const dotted = t.match(/([a-z_][a-z0-9_]*)$/i);
          return dotted ? dotted[1] : null;
        })
        .filter((x) => x !== null),
    );
  }
  return out;
}

const dir = 'supabase/migrations';
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const known = new Map(); // view -> { columns, file }
let findings = 0;
for (const f of files) {
  const defs = viewsIn(readFileSync(`${dir}/${f}`, 'utf8'));
  for (const [name, cols] of defs) {
    const prev = known.get(name);
    if (prev) {
      // `create or replace view` matches existing columns by position: the earlier definition must
      // be a prefix of the new one, or Postgres reports 42P16 "cannot change name of view column".
      for (let i = 0; i < prev.columns.length; i++) {
        if (cols[i] !== prev.columns[i]) {
          console.error(JSON.stringify({ check: 'view-columns', view: name, file: f, position: i + 1, was: prev.columns[i] ?? null, now: cols[i] ?? null, error: 'create or replace view would rename or drop this column; append new columns instead' }));
          findings++;
          break;
        }
      }
      if (cols.length < prev.columns.length) {
        console.error(JSON.stringify({ check: 'view-columns', view: name, file: f, error: `dropped ${prev.columns.length - cols.length} column(s)` }));
        findings++;
      }
    }
    known.set(name, { columns: cols, file: f });
  }
}
console.log(JSON.stringify({ check: 'view-columns', files: files.length, views: known.size, findings, ok: findings === 0 }));
process.exit(findings ? 1 : 0);
