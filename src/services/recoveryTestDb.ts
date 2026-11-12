import { Op } from "sequelize";
import { vi } from "vitest";

const literal = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Postgres ILIKE: % any run, _ one character, backslash escapes the next one. */
const likeRegex = (pattern: string) => {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) source += literal(pattern[++i]);
    else if (ch === "%") source += ".*";
    else if (ch === "_") source += ".";
    else source += literal(ch);
  }
  return new RegExp(`^${source}$`, "is");
};

/**
 * A tiny in-memory stand-in for the Sequelize models the recovery services
 * use (tests only). `where` supports equality, Op.in, Op.not / Op.ne (null or
 * a value) and Op.or of such clauses; rows are plain objects with update().
 */
type Row = Record<string, any>;

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, rule]) => {
    if (key === String(Op.or)) return (rule as Row[]).some((part) => matches(row, part));
    const value = row[key];
    if (rule && typeof rule === "object" && !(rule instanceof Date)) {
      const ops = rule as Record<symbol, unknown>;
      if (Op.in in ops) return (ops[Op.in] as unknown[]).includes(value);
      if (Op.notIn in ops) return !(ops[Op.notIn] as unknown[]).includes(value);
      // Like Postgres ILIKE (case-insensitive, % and _ wildcards).
      if (Op.iLike in ops) return likeRegex(String(ops[Op.iLike])).test(String(value ?? ""));
      if (Op.not in ops) return ops[Op.not] === null ? value !== null && value !== undefined : value !== ops[Op.not];
      if (Op.ne in ops) return value !== ops[Op.ne];
      if (Op.lt in ops) return value != null && value < (ops[Op.lt] as any);
      if (Op.gt in ops) return value != null && value > (ops[Op.gt] as any);
      if (Op.is in ops) return ops[Op.is] === null ? value === null || value === undefined : value === ops[Op.is];
    }
    return value === rule;
  });

const withSymbols = (where: Row = {}) => {
  const out: Row = {};
  for (const key of Reflect.ownKeys(where)) out[typeof key === "symbol" ? String(key) : key] = (where as any)[key];
  return out;
};

export const table = (model: any, rows: Row[]) => {
  let nextId = 1000;
  // Like a real database, reads return copies: a copy read earlier doesn't see
  // later writes (so races can be tested); update() on a copy writes the row.
  const copyOf = (row: Row): Row => {
    const copy: Row = { ...row };
    Object.assign(copy, {
      update: vi.fn(async (values: Row) => {
        const stored = rows.find((item) => item.id === row.id);
        if (stored) Object.assign(stored, values);
        return Object.assign(copy, values);
      }),
      destroy: vi.fn(async () => {
        const at = rows.findIndex((item) => item.id === row.id);
        if (at >= 0) rows.splice(at, 1);
      }),
      get: (key: string) => copy[key],
    });
    return copy;
  };
  const find = (options: Row = {}) => rows.filter((row) => matches(row, withSymbols(options.where)));
  vi.spyOn(model, "findAll").mockImplementation((async (options: Row) => find(options).map(copyOf)) as never);
  vi.spyOn(model, "findOne").mockImplementation((async (options: Row) => {
    const hit = find(options)[0];
    return hit ? copyOf(hit) : null;
  }) as never);
  vi.spyOn(model, "findByPk").mockImplementation((async (id: number) => {
    const hit = rows.find((row) => row.id === id);
    return hit ? copyOf(hit) : null;
  }) as never);
  vi.spyOn(model, "count").mockImplementation((async (options: Row) => find(options).length) as never);
  vi.spyOn(model, "create").mockImplementation((async (values: Row) => {
    const row = { id: nextId++, ...values };
    rows.push(row);
    return copyOf(row);
  }) as never);
  vi.spyOn(model, "destroy").mockImplementation((async (options: Row) => {
    const gone = find(options);
    gone.forEach((row) => rows.splice(rows.indexOf(row), 1));
    return gone.length;
  }) as never);
  vi.spyOn(model, "update").mockImplementation((async (values: Row, options: Row) => {
    const hit = find(options);
    hit.forEach((row) => Object.assign(row, values));
    return [hit.length];
  }) as never);
  return rows;
};
