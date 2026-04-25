/**
 * Regression tests for js/tool-schema.js — the validator/coercer that
 * filters every LLM-proposed op before it reaches executeIntelOp.
 * These are safety-critical: if the validator is wrong, arbitrary model
 * output can touch user data.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');

function loadSchema() {
  const win = {};
  const fn = new Function('window', src);
  fn(win);
  return win;
}

function ctxFrom(tasksArr, listsArr) {
  return {
    tasksById: new Map(tasksArr.map((t) => [t.id, t])),
    listsById: new Map((listsArr || []).map((l) => [l.id, l])),
  };
}

test('schema block enumerates every op name', () => {
  const { toolSchemaPromptBlock, TOOL_SCHEMA } = loadSchema();
  const block = toolSchemaPromptBlock();
  for (const name of Object.keys(TOOL_SCHEMA)) {
    assert.match(block, new RegExp('- ' + name + '\\('), 'missing ' + name);
  }
});

test('OPEN_TASK_DETAIL is not an LLM tool (removed from schema)', () => {
  const { TOOL_SCHEMA } = loadSchema();
  assert.equal(TOOL_SCHEMA.OPEN_TASK_DETAIL, undefined);
});

test('every TOOL_SCHEMA entry has boolean readOnly and destructive', () => {
  const { TOOL_SCHEMA } = loadSchema();
  for (const [name, def] of Object.entries(TOOL_SCHEMA)) {
    assert.equal(typeof def.readOnly, 'boolean', name + '.readOnly');
    const d = def.destructive;
    assert.ok(d === false || d === 'mass' || d === 'always', name + '.destructive');
  }
});

test('validator: SNOOZE_TASK coerces id and untilDate', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps([{ name: 'SNOOZE_TASK', args: { id: '5', untilDate: '2026-05-01' } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.strictEqual(r.valid[0].args.id, 5);
  assert.equal(r.valid[0].args.untilDate, '2026-05-01');
});

test('tolerant JSON parser strips code fences and ignores trailing prose', () => {
  const { parseOpsJson } = loadSchema();
  const out = parseOpsJson('```json\n[{"name":"MARK_DONE","args":{"id":5}}]\n```\n\nSome trailing text');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'MARK_DONE');
});

test('validator: happy path passes', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], [{ id: 9, name: 'L' }]);
  const r = validateOps([{ name: 'MARK_DONE', args: { id: 5 } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.destructiveLevel, 'none');
});

test('validator: unknown task id is rejected', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps([{ name: 'MARK_DONE', args: { id: 999 } }], ctx);
  assert.equal(r.valid.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /UNKNOWN_TASK_ID/);
});

test('validator: unknown list id is rejected', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], [{ id: 9, name: 'L' }]);
  const r = validateOps([{ name: 'CHANGE_LIST', args: { id: 5, listId: 77 } }], ctx);
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reason, /UNKNOWN_LIST_ID/);
});

test('validator: enum coercion (priority, status, effort, recur)', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps([
    { name: 'UPDATE_TASK', args: { id: 5, priority: 'Urgent', status: 'DONE', effort: 'L', type: 'TASK' } },
    { name: 'SET_RECUR', args: { id: 5, recur: 'Daily' } },
  ], ctx);
  assert.equal(r.valid.length, 2);
  assert.equal(r.valid[0].args.priority, 'urgent');
  assert.equal(r.valid[0].args.status, 'done');
  assert.equal(r.valid[0].args.effort, 'l');
  assert.equal(r.valid[0].args.type, 'task');
  assert.equal(r.valid[1].args.recur, 'daily');
});

test('validator: invalid enum values are dropped, not passed through', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps([{ name: 'UPDATE_TASK', args: { id: 5, priority: 'NUCLEAR' } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].args.priority, undefined);
});

test('validator: tags coerced from comma/space string to array, # stripped', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps([{ name: 'CREATE_TASK', args: { name: 'X', tags: '#a, b c,#d' } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.valid[0].args.tags, ['a', 'b', 'c', 'd']);
});

test('validator: DELETE_TASK on non-archived rejected', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps([{ name: 'DELETE_TASK', args: { id: 5 } }], ctx);
  assert.equal(r.valid.length, 0);
  assert.equal(r.rejected[0].reason, 'TASK_NOT_ARCHIVED');
});

test('validator: DELETE on archived is allowed and destructiveLevel=hard', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: true }], []);
  const r = validateOps([{ name: 'DELETE_TASK', args: { id: 5 } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.equal(r.destructiveLevel, 'hard');
});

test('validator: mass ARCHIVE (≥5) is hard destructive', () => {
  const { validateOps } = loadSchema();
  const tasks = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: 'T', archived: false }));
  const ctx = ctxFrom(tasks, []);
  const r = validateOps(tasks.map((t) => ({ name: 'ARCHIVE_TASK', args: { id: t.id } })), ctx);
  assert.equal(r.valid.length, 6);
  assert.equal(r.destructiveLevel, 'hard');
});

test('validator: 1–4 ARCHIVE is warn level', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 1, archived: false }, { id: 2, archived: false }, { id: 3, archived: false }], []);
  const r = validateOps(
    [{ name: 'ARCHIVE_TASK', args: { id: 1 } }, { name: 'ARCHIVE_TASK', args: { id: 2 } }, { name: 'ARCHIVE_TASK', args: { id: 3 } }],
    ctx,
  );
  assert.equal(r.destructiveLevel, 'warn');
});

test('validator: >50 ops triggers truncation flag', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const r = validateOps(Array.from({ length: 55 }, () => ({ name: 'MARK_DONE', args: { id: 5 } })), ctx);
  assert.equal(r.valid.length, 50);
  assert.equal(r.truncated, true);
});

test('validator: ops past batch cap get BATCH_LIMIT rejection entries', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const ops = Array.from({ length: 52 }, (_, i) => ({ name: 'MARK_DONE', args: { id: 5 }, _seq: i }));
  const r = validateOps(ops, ctx);
  assert.equal(r.valid.length, 50);
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.every((x) => /BATCH_LIMIT/.test(x.reason)));
});

test('validator: ARCHIVE_TASK then DELETE_TASK in same batch validates', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps(
    [{ name: 'ARCHIVE_TASK', args: { id: 5 } }, { name: 'DELETE_TASK', args: { id: 5 } }],
    ctx,
  );
  assert.equal(r.valid.length, 2);
  assert.equal(r.rejected.length, 0);
});

test('validator: ARCHIVE_TASK with parentId cycle in tasksById completes (batch sim BFS)', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom(
    [
      { id: 1, name: 'A', archived: false, parentId: 2 },
      { id: 2, name: 'B', archived: false, parentId: 1 },
    ],
    [],
  );
  const r = validateOps([{ name: 'ARCHIVE_TASK', args: { id: 1 } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.equal(r.rejected.length, 0);
});

test('validator: MOVE_TASK rejects moving under own descendant (MOVE_WOULD_CYCLE)', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom(
    [
      { id: 1, name: 'R', archived: false, parentId: null },
      { id: 2, name: 'C', archived: false, parentId: 1 },
      { id: 3, name: 'G', archived: false, parentId: 2 },
    ],
    [],
  );
  const r = validateOps([{ name: 'MOVE_TASK', args: { id: 1, newParentId: 3 } }], ctx);
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reason, /MOVE_WOULD_CYCLE/);
});

test('validator: CREATE_TASK then UPDATE_TASK on next synthetic id validates', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 10, name: 'Existing', archived: false }], []);
  const r = validateOps(
    [
      { name: 'CREATE_TASK', args: { name: 'New row' } },
      { name: 'UPDATE_TASK', args: { id: 11, priority: 'urgent' } },
    ],
    ctx,
  );
  assert.equal(r.valid.length, 2);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.valid[1].args.id, 11);
  assert.equal(r.valid[1].args.priority, 'urgent');
});

test('validator: unknown parentId on CREATE_TASK is rejected', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const r = validateOps([{ name: 'CREATE_TASK', args: { name: 'Child', parentId: 999 } }], ctx);
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reason, /UNKNOWN_PARENT_ID/);
});

test('validator: non-array input rejected with NOT_AN_ARRAY', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([], []);
  const r = validateOps({ name: 'MARK_DONE', args: { id: 1 } }, ctx);
  assert.equal(r.valid.length, 0);
  assert.equal(r.rejected[0].reason, 'NOT_AN_ARRAY');
});

test('validator: unknown op name rejected with UNKNOWN_OP', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const r = validateOps([{ name: 'DROP_TABLE', args: { id: 5 } }], ctx);
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reason, /UNKNOWN_OP/);
});

test('validator: missing required field rejected with MISSING_REQUIRED', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([], []);
  const r = validateOps([{ name: 'CREATE_TASK', args: {} }], ctx);
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reason, /MISSING_REQUIRED/);
});

test('validator: date coercion accepts ISO date only (no locale fallback)', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const ok = validateOps([{ name: 'UPDATE_TASK', args: { id: 5, dueDate: '2026-12-31' } }], ctx);
  assert.equal(ok.valid[0].args.dueDate, '2026-12-31');
  const bad = validateOps([{ name: 'UPDATE_TASK', args: { id: 5, dueDate: '12/31/2026' } }], ctx);
  assert.equal(bad.valid[0].args.dueDate, undefined);
});

test('validator: description strips control chars but keeps tab newline CR', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const dirty = 'hello\u0000world\u007fend\n\ttab\rCR';
  const r = validateOps([{ name: 'UPDATE_TASK', args: { id: 5, description: dirty } }], ctx);
  assert.equal(r.valid[0].args.description, 'helloworldend\n\ttab\rCR');
});

test('validator: name field coercion preserves carriage return', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([], []);
  const r = validateOps([{ name: 'CREATE_TASK', args: { name: 'a\r\nb' } }], ctx);
  assert.equal(r.valid[0].args.name, 'a\r\nb');
});

test('parser: escaped quotes and backslashes inside strings round-trip', () => {
  const { parseOpsJson } = loadSchema();
  const raw = '[{"name":"ADD_NOTE","args":{"id":1,"text":"say \\"hi\\" and \\\\ run"}}]';
  const out = parseOpsJson(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].args.text, 'say "hi" and \\ run');
});

test('parser: nested bracket inside string value does not end outer array early', () => {
  const { parseOpsJson } = loadSchema();
  const raw = '[{"name":"ADD_NOTE","args":{"id":1,"text":"has ] bracket"}}]';
  const out = parseOpsJson(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].args.text, 'has ] bracket');
});

test('validator: coerce int id from decimal string', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 42, archived: false }], []);
  const r = validateOps([{ name: 'MARK_DONE', args: { id: '42' } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.strictEqual(r.valid[0].args.id, 42);
});

test('validator: float/alphanumeric id is rejected, not silently truncated', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const r = validateOps([
    { name: 'MARK_DONE', args: { id: '5abc' } },
    { name: 'MARK_DONE', args: { id: '5.7' } },
  ], ctx);
  assert.equal(r.valid.length, 0);
  assert.equal(r.rejected.length, 2);
});

// Pins documented leniency: numeric (not string) floats truncate via Math.trunc,
// which lets LLMs that emit 5.0 / 5.9 still reach a real id rather than failing
// validation. The asymmetry with the string test above is intentional —
// see comment on _coerceInt in tool-schema.js.
test('validator: numeric float id is truncated (not rejected)', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, archived: false }], []);
  const r = validateOps([{ name: 'MARK_DONE', args: { id: 5.9 } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.strictEqual(r.valid[0].args.id, 5);
});

test('validator: limit defaults to 20 for non-numeric input', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([], []);
  const r = validateOps([{ name: 'QUERY_TASKS', args: { limit: 'abc' } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.strictEqual(r.valid[0].args.limit, 20);
});

test('validator: SPLIT_TASK accepts 2–8 part names, rejects single part', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 1, name: 'T', archived: false }], []);
  const two = validateOps([{ name: 'SPLIT_TASK', args: { id: 1, parts: [{ name: 'A' }, { name: 'B' }] } }], ctx);
  assert.equal(two.valid.length, 1);
  assert.equal(two.valid[0].args.parts.length, 2);
  const eight = validateOps([{
    name: 'SPLIT_TASK',
    args: {
      id: 1,
      parts: Array.from({ length: 8 }, (_, i) => ({ name: 'p' + i })),
    },
  }], ctx);
  assert.equal(eight.valid.length, 1);
  assert.equal(eight.valid[0].args.parts.length, 8);
  const one = validateOps([{ name: 'SPLIT_TASK', args: { id: 1, parts: [{ name: 'Only' }] } }], ctx);
  assert.equal(one.valid.length, 0);
  assert.match(one.rejected[0].reason, /MISSING_REQUIRED:parts/);
});

test('validator: CREATE_FROM_EVENT coerces feedId and eventUid to strings', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([], []);
  const r = validateOps([{ name: 'CREATE_FROM_EVENT', args: { feedId: 42, eventUid: 99 } }], ctx);
  assert.equal(r.valid.length, 1);
  assert.strictEqual(r.valid[0].args.feedId, '42');
  assert.strictEqual(r.valid[0].args.eventUid, '99');
  const m = validateOps([{ name: 'CREATE_FROM_EVENT', args: { feedId: 'a' } }], ctx);
  assert.equal(m.valid.length, 0);
  assert.match(m.rejected[0].reason, /MISSING_REQUIRED/);
});

test('validator: op must include plain args object (not raw op fallback)', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([], []);
  const r = validateOps([{ name: 'CREATE_TASK' }], ctx);
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reason, /MISSING_OR_INVALID_ARGS/);
});

test('parser: first JSON array on a new line is preferred over stray [ in prose', () => {
  const { parseOpsJson } = loadSchema();
  const raw = 'Notes: see [old] list.\n[{"name":"MARK_DONE","args":{"id":1}}]';
  const out = parseOpsJson(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'MARK_DONE');
});
