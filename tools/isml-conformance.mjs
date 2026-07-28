// ISML CONFORMANCE HARNESS
//
// Runs AI-ML against the 32 example files from Robert Harper's Introduction to
// Standard ML course at CMU, one top-level declaration at a time, and reports
// how many the console accepts.
//
//   node tools/isml-conformance.mjs            # fetch (once) and run
//   node tools/isml-conformance.mjs --verbose  # show every failing line
//
// WHY IT IS HERE. Every test in test/ was written beside the feature it tests
// and shares that author's assumptions about what the feature is for. Harper's
// files do not: they were written in 1993 to teach Standard ML, with no
// knowledge of this dialect. That is what makes them a measurement rather than
// a confirmation, and running them found more in an afternoon than four
// sessions of our own tests had — clausal definitions, @, records, type
// variables, blocks and as-patterns were all added because these files wanted
// them, and two silent bugs surfaced that no test had caught.
//
// THE FILES ARE NOT IN THIS REPOSITORY. They are Harper's teaching material and
// are fetched from cs.cmu.edu on first run into a gitignored directory. If the
// fetch fails, the harness says so and stops; nothing here reproduces them.
//
// A WARNING FROM EXPERIENCE. The translator below is crude on purpose, and it
// has been wrong twice in ways that looked like language failures: it once ate
// the second colon of every `h::t`, and it once turned each second clause's
// defining `=` into `==`. Both times the score dropped and the language was
// fine. Before believing a regression here, check the translator.

import { runRonml, loadPrelude } from '../src/game/ai_ml.js';
import fs from 'fs';

// ---- Splitting source into top-level declarations --------------------------
//
// This is the part of the harness most likely to be wrong, and it has been:
// the version before this one split at column 0 on a keyword list that INCLUDED
// `in` and `end`, so every `local … in … end` and every `structure S = struct
// … end` was cut into two or three fragments, each of which then failed to
// parse on its own. It also ended a declaration at any blank line, and stripped
// comments with a non-greedy regex that cannot see SML's NESTED comments.
// Together that accounted for roughly a quarter of all reported failures, and
// every one of them looked like a language gap.
//
// The rule now: a declaration ends only at nesting depth zero.

const OPENERS = new Set(['let', 'local', 'struct', 'sig', 'abstype']);
const STARTERS = new Set(['fun', 'val', 'datatype', 'type', 'exception', 'local',
  'structure', 'signature', 'functor', 'infix', 'infixr', 'nonfix', 'open',
  'abstype', 'withtype']);

// Blank out comments and string bodies, preserving length and line breaks, so
// that line- and word-based logic afterwards cannot be fooled by a keyword
// inside a comment or a quoted string. SML comments nest, so this counts depth
// rather than matching a first `*)`.
function mask(src) {
  const out = src.split('');
  let depth = 0, inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (depth > 0) {
      if (c === '(' && d === '*') { depth++; out[i] = out[i + 1] = ' '; i++; continue; }
      if (c === '*' && d === ')') { depth--; out[i] = out[i + 1] = ' '; i++; continue; }
      if (c !== '\n') out[i] = ' ';
      continue;
    }
    if (inStr) {
      if (c === '\\') { out[i] = ' '; if (d !== undefined && d !== '\n') { out[i + 1] = ' '; i++; } continue; }
      if (c === '"') { inStr = false; out[i] = ' '; continue; }
      if (c !== '\n') out[i] = ' ';
      continue;
    }
    if (c === '(' && d === '*') { depth++; out[i] = out[i + 1] = ' '; i++; continue; }
    if (c === '"') { inStr = true; out[i] = ' '; continue; }
  }
  return out.join('');
}

// How far a line moves the block nesting: openers up, `end` down. Counted over
// words only, on the masked text.
function depthDelta(maskedLine) {
  let d = 0;
  for (const w of maskedLine.match(/[A-Za-z_'][A-Za-z0-9_']*/g) || []) {
    if (OPENERS.has(w)) d++;
    else if (w === 'end') d--;
  }
  return d;
}

export function decls(src) {
  const lines = src.split('\n');
  const masked = mask(src).split('\n');
  const out = [];
  let cur = [];
  let depth = 0;
  const flush = () => { if (cur.length) { out.push(cur.join('\n')); cur = []; } };

  for (let i = 0; i < lines.length; i++) {
    const m = masked[i];
    // A new declaration begins only when nothing is open: inside a `struct` the
    // word `fun` starts a member, not a top-level declaration.
    const startsDecl = depth === 0
      && /^[A-Za-z]/.test(m)
      && STARTERS.has((m.match(/^[A-Za-z_'][A-Za-z0-9_']*/) || [''])[0]);
    if (startsDecl) flush();
    if (m.trim()) cur.push(lines[i]);
    else if (depth === 0) flush();          // a blank line ends a declaration
    else if (cur.length) cur.push(lines[i]); // …but not one that is still open
    depth = Math.max(0, depth + depthDelta(m));
  }
  flush();
  // Strip the comments only now, for the interpreter's benefit, and drop any
  // fragment that was nothing but a comment.
  return out
    .map((d) => stripComments(d).trim())
    .filter(Boolean);
}

// Comment removal that respects nesting, for the text actually handed over.
function stripComments(src) {
  let out = '', depth = 0, inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (depth > 0) {
      if (c === '(' && d === '*') { depth++; i++; continue; }
      if (c === '*' && d === ')') { depth--; i++; continue; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\' && d !== undefined) { out += d; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '(' && d === '*') { depth++; i++; continue; }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

// Mechanically translate the parts of SML that AI-ML spells differently.
// Clausal definitions become one `case`, which is the single biggest rewrite
// and the one Harper's own Restrictions note predicts.
function translate(d) {
  let s = d;
  // PRUNE THIS WHENEVER THE LANGUAGE GROWS. It has been out of date after every
  // single addition so far: it went on skipping modules and exceptions after
  // v1.252 added them, went on rewriting chars and `~` after v1.255 did, and
  // was still skipping `local`, `functor`, `ref` and the whole standard library
  // at v1.273 — all four of which v1.257 had added. Each time the score
  // under-reported and the gain was invisible.
  //
  // Every entry below was re-verified against the interpreter on 2026-07-27 by
  // running an example of it, not by reading the code. `local`, `functor`,
  // `ref`/`:=`, and the List/String/Int/Option structures all work and are no
  // longer skipped.
  if (/^(infix|infixr|nonfix|open|abstype)\b/.test(s)) return null;  // no fixity, no open, no abstype
  // Char and Real were added to the prelude in v1.285 (L-G) and are no longer
  // skipped. Everything still listed here has no implementation at all.
  if (/\b(Word|Array|Vector|IO|TextIO|OS|Math|General|Substring)\./.test(s)) return null;

  // Nothing else is rewritten. #"a" is a char here now, ~n is unary minus,
  // annotations are checked, andalso/orelse are spelled as they are in ML, and
  // `fun` and `val` are accepted words. The console is asked what it makes of
  // the line as written.
  s = s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(=)\s*$/.test(s)) return null;
  return s;
}

const NAMES = ['ascription', 'clauses', 'concur', 'datatype', 'excs', 'fcnls', 'fcns',
  'hierarchies', 'io', 'lists', 'matching', 'memo', 'optexccont', 'parameterization',
  'perseph', 'prodpat', 'recfcn', 'recind', 'refs', 'regexp', 'repinv', 'seq', 'sharing',
  'sigstr', 'specs', 'streams', 'strind', 'subfun', 'typinf', 'typval', 'vardec', 'views'];
const DIR = 'tools/.isml-cache';
const BASE = 'https://www.cs.cmu.edu/~rwh/isml/examples';

// Only run the survey when invoked as a program. `decls` is exported so a test
// can check the splitter without fetching a corpus or running an interpreter —
// which is the point: the instrument gets tested like anything else now.
const RUN = import.meta.url === `file://${process.argv[1]}`;
if (!RUN) { /* imported for `decls` */ } else {

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
for (const n of NAMES) {
  const at = `${DIR}/${n}.sml`;
  if (fs.existsSync(at)) continue;
  try {
    const res = await fetch(`${BASE}/${n}.sml`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(at, await res.text());
  } catch (e) {
    console.error(`could not fetch ${n}.sml from ${BASE} — ${e.message}`);
    console.error('The corpus is Harper\'s and is not vendored here. Check the network, or the URL if the course has moved.');
    process.exit(1);
  }
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sml')).sort();
const report = [];
for (const f of files) {
  const src = fs.readFileSync(`${DIR}/${f}`, 'utf8');
  const ds = decls(src);
  // LOAD THE LIBRARY. Until v1.285 this line did not, so every declaration in
  // the corpus calling List.find or String.tokens failed on a name the build
  // actually had, and the whole of L-G measured as zero gain. The in-game
  // terminal loads the prelude on its first line; the instrument must do what
  // the thing it measures does.
  const ctx = { station: 'laptop', session: {} };
  loadPrelude(ctx);
  let attempted = 0, ok = 0, skipped = 0;
  const errs = [];
  for (const d of ds) {
    const t = translate(d);
    if (t === null) { skipped++; continue; }
    attempted++;
    let r;
    try { r = runRonml(t, ctx); } catch (e) { r = { text: `ERR: ${e.message}` }; }
    if (String(r.text).startsWith('ERR')) errs.push([t.slice(0, 58), String(r.text).replace(/^ERR:\s*/, '').slice(0, 46)]);
    else ok++;
  }
  report.push({ f, total: ds.length, attempted, ok, skipped, errs });
}
for (const r of report) {
  const pct = r.attempted ? Math.round((r.ok / r.attempted) * 100) : 0;
  console.log(`${r.f.padEnd(22)} decls ${String(r.total).padStart(3)}  tried ${String(r.attempted).padStart(3)}  ran ${String(r.ok).padStart(3)} (${String(pct).padStart(3)}%)  skipped ${String(r.skipped).padStart(3)}`);
  const show = process.argv.includes('--verbose') ? r.errs.length : 3;
  for (const [t, e] of r.errs.slice(0, show)) console.log(`      × ${t}\n        ${e}`);
}
const T = report.reduce((a, r) => ({ a: a.a + r.attempted, o: a.o + r.ok, s: a.s + r.skipped }), { a: 0, o: 0, s: 0 });
console.log(`\nTOTAL attempted ${T.a}, ran ${T.o} (${Math.round(T.o / T.a * 100)}%), skipped as out-of-scope ${T.s}`);

console.log('\nThe skipped ones are the remaining documented absences: infix/nonfix,');
console.log('open, abstype, and the Basis structures beyond List/String/Int/Option.');
console.log('See the Restrictions page in the game, and docs/ob-terminal-language.md.');

}
