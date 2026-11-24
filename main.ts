// main.ts is mend, the CLI SPEC.md specifies. It applies AI-written edits in four formats (unified diffs
// with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text
// files, finding the lines each edit names at the first of three matching tiers, and changing every
// file or none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Shared line handling (SPEC.md sections 3 and 5) ----

/** A file's lines, its own line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  fin: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function renderFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.fin ? st.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions where oldLines occur in lines at one tier, at or after `from`. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0 || lines.length < n) return out;
  for (let i = Math.max(0, from); i + n <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (!lineEq(lines[i + k]!, oldLines[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which oldLines occur (at or after `from`), with its positions. */
function findTier(lines: string[], oldLines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

type SeqKind = 'ctx' | 'del' | 'add';
interface SeqLine {
  text: string;
  kind: SeqKind;
}

/**
 * The file's lines with the matched block at `at` replaced: a context line of the new
 * sequence is the file's own matched line, and at tier 2 every other new line is
 * re-indented from the old sequence's first line's indent to the file's.
 */
function spliceSeq(fileLines: string[], at: number, oldSeq: SeqLine[], newSeq: SeqLine[], tier: number): string[] {
  const oCtx: number[] = [];
  oldSeq.forEach((e, i) => {
    if (e.kind === 'ctx') oCtx.push(i);
  });
  const f = at < fileLines.length ? leadingWs(fileLines[at]!) : '';
  const p = oldSeq.length > 0 ? leadingWs(oldSeq[0]!.text) : '';
  const out: string[] = [];
  let ci = 0;
  for (const e of newSeq) {
    if (e.kind === 'ctx') {
      out.push(fileLines[at + oCtx[ci]!]!);
      ci += 1;
    } else if (tier === 2) {
      const t = e.text;
      out.push(t === '' || t.trim() === '' ? t : t.startsWith(p) ? f + t.slice(p.length) : t);
    } else {
      out.push(e.text);
    }
  }
  return [...fileLines.slice(0, at), ...out, ...fileLines.slice(at + oldSeq.length)];
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  oldSeq: SeqLine[];
  newSeq: SeqLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNewline: boolean;
  /** a `\` line follows the hunk's last `+` line, null when the hunk has none */
  plusNoNewline: boolean | null;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDiffPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Sec {
    diffOld: string | null;
    diffNew: string | null;
    minus: string | null | undefined;
    plus: string | null | undefined;
    renameFrom: string | undefined;
    renameTo: string | undefined;
    newFile: boolean;
    deletedFile: boolean;
    hunks: Hunk[];
  }
  const sections: Sec[] = [];
  let cur: Sec | null = null;
  let seenHunk = false;
  let pairSeen = false;

  const startSection = (): Sec => {
    const s: Sec = {
      diffOld: null,
      diffNew: null,
      minus: undefined,
      plus: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    seenHunk = false;
    pairSeen = false;
    return s;
  };

  const parseHunk = (i: number): { hunk: Hunk; next: number } => {
    const m = HUNK_HEAD.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const a = Number(m[1]);
    const body: { kind: 'ctx' | 'del' | 'add' | 'mark'; text: string }[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '') {
        body.push({ kind: 'ctx', text: '' });
        j += 1;
        continue;
      }
      const c = l[0]!;
      if (c === ' ') {
        body.push({ kind: 'ctx', text: l.slice(1) });
        j += 1;
        continue;
      }
      if (c === '-') {
        body.push({ kind: 'del', text: l.slice(1) });
        j += 1;
        continue;
      }
      if (c === '+') {
        body.push({ kind: 'add', text: l.slice(1) });
        j += 1;
        continue;
      }
      if (c === '\\') {
        body.push({ kind: 'mark', text: l.slice(1) });
        j += 1;
        continue;
      }
      break;
    }
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') body.pop();
      else break;
    }
    let noNewline = false;
    let plusNoNewline: boolean | null = null;
    for (let k = body.length - 1; k >= 0; k--) {
      const e = body[k]!;
      if (e.kind === 'ctx' || e.kind === 'add') {
        noNewline = body[k + 1] !== undefined && body[k + 1]!.kind === 'mark';
        break;
      }
    }
    for (let k = body.length - 1; k >= 0; k--) {
      const e = body[k]!;
      if (e.kind === 'add') {
        plusNoNewline = body[k + 1] !== undefined && body[k + 1]!.kind === 'mark';
        break;
      }
    }
    const oldSeq: SeqLine[] = [];
    const newSeq: SeqLine[] = [];
    for (const e of body) {
      if (e.kind === 'ctx') {
        oldSeq.push({ text: e.text, kind: 'ctx' });
        newSeq.push({ text: e.text, kind: 'ctx' });
      } else if (e.kind === 'del') oldSeq.push({ text: e.text, kind: 'del' });
      else if (e.kind === 'add') newSeq.push({ text: e.text, kind: 'add' });
    }
    return { hunk: { a, oldSeq, newSeq, noNewline, plusNoNewline }, next: j };
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(i);
      cur.hunks.push(hunk);
      seenHunk = true;
      i = next;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && !seenHunk && !pairSeen) {
          cur.minus = parseDiffPath(l.slice(4));
          cur.plus = parseDiffPath(lines[i + 1]!.slice(4));
          pairSeen = true;
        } else {
          const s = startSection();
          s.minus = parseDiffPath(l.slice(4));
          s.plus = parseDiffPath(lines[i + 1]!.slice(4));
          pairSeen = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && !seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && !seenHunk) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    let oldP: string | null;
    let newP: string | null;
    if (s.minus !== undefined) {
      oldP = s.minus;
      newP = s.plus!;
    } else {
      oldP = s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
      newP = s.renameTo !== undefined ? s.renameTo : s.diffNew;
    }
    if (oldP === null && newP === null) {
      edits.push(() => undefined);
      continue;
    }
    const isCreate = newP !== null && (oldP === null || s.newFile);
    const isDelete = !isCreate && oldP !== null && (newP === null || s.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const p = newP!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastPlusNoNewline = false;
        for (const h of s.hunks) {
          for (const e of h.newSeq) {
            if (e.kind === 'add') plus.push(e.text);
          }
          if (h.plusNoNewline !== null) lastPlusNoNewline = h.plusNoNewline;
        }
        // A created file ends with a line break unless a `\` line follows its last `+` line;
        // with no `+` lines at all the file is empty and has no final break.
        const fin = plus.length > 0 && !lastPlusNoNewline;
        tree.now.set(p, renderFile({ lines: plus, br: '\n', fin }));
      });
      continue;
    }
    if (isDelete) {
      const p = oldP!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (isMove) {
      const o = oldP!;
      const n = newP!;
      edits.push((tree) => {
        if (!safe(o)) throw new Fail('unsafe', o);
        if (!safe(n)) throw new Fail('unsafe', n);
        const text = tree.get(o);
        if (text === null) throw new Fail('missing', o);
        if (tree.get(n) !== null) throw new Fail('exists', n);
        let st = parseFile(text);
        let d = 0;
        for (const h of s.hunks) {
          st = applyHunk(st, h, d, strict, o);
          d += h.newSeq.length - h.oldSeq.length;
        }
        tree.now.set(o, null);
        tree.now.set(n, renderFile(st));
        tree.moves.push([o, n]);
      });
      continue;
    }
    const p = oldP!;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      let st = parseFile(text);
      let d = 0;
      for (const h of s.hunks) {
        st = applyHunk(st, h, d, strict, p);
        d += h.newSeq.length - h.oldSeq.length;
      }
      tree.now.set(p, renderFile(st));
    });
  }
  return edits;
}

/** Apply one unified hunk to a file's state; `d` is the line drift of earlier hunks. */
function applyHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  if (h.oldSeq.length === 0) {
    if (h.newSeq.length === 0) return st;
    const pos = Math.min(Math.max(h.a + d, 0), st.lines.length);
    const ins = h.newSeq.map((e) => e.text);
    const lines = [...st.lines.slice(0, pos), ...ins, ...st.lines.slice(pos)];
    const fin = pos === st.lines.length ? !h.noNewline : st.fin;
    return { lines, br: st.br, fin };
  }
  const oldLines = h.oldSeq.map((e) => e.text);
  const found = findTier(st.lines, oldLines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.occ[0]!;
  let best = Math.abs(at - target);
  for (const o of found.occ) {
    const dist = Math.abs(o - target);
    if (dist < best) {
      best = dist;
      at = o;
    }
  }
  const lines = spliceSeq(st.lines, at, h.oldSeq, h.newSeq, found.tier);
  const fin = at + oldLines.length === st.lines.length ? !h.noNewline : st.fin;
  return { lines, br: st.br, fin };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, renderFile({ lines: newLines, br: '\n', fin: newLines.length > 0 }));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = parseFile(text);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const oldSeq: SeqLine[] = oldLines.map((t) => ({ text: t, kind: 'del' as const }));
    const newSeq: SeqLine[] = newLines.map((t) => ({ text: t, kind: 'add' as const }));
    const lines = spliceSeq(st.lines, at, oldSeq, newSeq, found.tier);
    tree.now.set(path, renderFile({ lines, br: st.br, fin: st.fin }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b.path, b.oldLines, b.newLines, strict));
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldSeq: SeqLine[];
  newSeq: SeqLine[];
}

function applyV4aChunk(st: FileState, c: VChunk, cursor: number, strict: boolean, path: string): { st: FileState; cursor: number } {
  let cur = cursor;
  if (c.anchor !== null) {
    let foundIdx = -1;
    for (const t of tiers(strict)) {
      for (let k = cur; k < st.lines.length; k++) {
        if (lineEq(st.lines[k]!, c.anchor, t)) {
          foundIdx = k;
          break;
        }
      }
      if (foundIdx >= 0) break;
    }
    if (foundIdx < 0) throw new Fail('no-match', path);
    cur = foundIdx + 1;
  }
  const oldLines = c.oldSeq.map((e) => e.text);
  if (oldLines.length === 0) {
    const pos = c.eof ? st.lines.length : cur;
    const ins = c.newSeq.map((e) => e.text);
    const lines = [...st.lines.slice(0, pos), ...ins, ...st.lines.slice(pos)];
    return { st: { lines, br: st.br, fin: st.fin }, cursor: pos + ins.length };
  }
  let at = -1;
  let tier = 0;
  for (const t of tiers(strict)) {
    for (let k = cur; k + oldLines.length <= st.lines.length; k++) {
      if (c.eof && k + oldLines.length !== st.lines.length) continue;
      let ok = true;
      for (let m = 0; m < oldLines.length; m++) {
        if (!lineEq(st.lines[k + m]!, oldLines[m]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        at = k;
        tier = t;
        break;
      }
    }
    if (at >= 0) break;
  }
  if (at < 0) throw new Fail('no-match', path);
  const lines = spliceSeq(st.lines, at, c.oldSeq, c.newSeq, tier);
  return { st: { lines, br: st.br, fin: st.fin }, cursor: at + c.newSeq.length };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  interface RawLine {
    text: string;
    num: number;
  }
  interface Section {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headNum: number;
    raw: RawLine[];
  }
  const sections: Section[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: Section['kind'] | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headNum = i + 1;
    i += 1;
    const raw: RawLine[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push({ kind, path, headNum, raw });
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const ls: string[] = [];
      for (const r of s.raw) {
        if (r.text.startsWith('+')) ls.push(r.text.slice(1));
        else if (r.text === '') ls.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, renderFile({ lines: ls, br: '\n', fin: ls.length > 0 }));
      });
    } else if (s.kind === 'delete') {
      const bad = s.raw.find((r) => !blank(r.text));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.num}`);
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: { kind: 'ctx' | 'del' | 'add'; text: string }[] } | null = null;
      let seenContent = false;
      const closeChunk = (): void => {
        if (cur === null) return;
        const oldSeq: SeqLine[] = [];
        const newSeq: SeqLine[] = [];
        for (const e of cur.body) {
          if (e.kind === 'ctx') {
            oldSeq.push({ text: e.text, kind: 'ctx' });
            newSeq.push({ text: e.text, kind: 'ctx' });
          } else if (e.kind === 'del') oldSeq.push({ text: e.text, kind: 'del' });
          else newSeq.push({ text: e.text, kind: 'add' });
        }
        chunks.push({ anchor: cur.anchor, eof: cur.eof, oldSeq, newSeq });
        cur = null;
      };
      for (const r of s.raw) {
        const t = r.text;
        if (!seenContent && t.startsWith('*** Move to: ')) {
          moveTo = t.slice(13).trim();
          seenContent = true;
          continue;
        }
        if (t.startsWith('@@')) {
          closeChunk();
          const a = t.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          seenContent = true;
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          closeChunk();
          seenContent = true;
          continue;
        }
        if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          if (t === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (t.startsWith(' ')) cur.body.push({ kind: 'ctx', text: t.slice(1) });
          else if (t.startsWith('-')) cur.body.push({ kind: 'del', text: t.slice(1) });
          else cur.body.push({ kind: 'add', text: t.slice(1) });
          seenContent = true;
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.headNum}`);
      const p = s.path;
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        let st = parseFile(text);
        let cursor = 0;
        for (const c of chunks) {
          const r = applyV4aChunk(st, c, cursor, strict, p);
          st = r.st;
          cursor = r.cursor;
        }
        const out = renderFile(st);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, out);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.get(o) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
