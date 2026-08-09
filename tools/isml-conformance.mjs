// NostOS — a postAI Odyssey.
// Copyright (C) 2026 David M. Berry
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for details: <https://www.gnu.org/licenses/>.

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

// M4 (v1.288): imports the LANGUAGE, not the game. The harness measures how
// much Standard ML this implementation runs, so pulling it through the game's
// console adapter meant measuring the adapter too — its station verb tables
// were in scope, and a corpus declaration that happened to name one got the
// game's wording instead of the language's.
import { createInterpreter } from '../src/index.js';
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
// The Basis structures with no implementation at all. Named once, so the
// summary at the end prints THIS list rather than a sentence about it: the
// sentence has been wrong after every addition since v1.252.
// v1.306: eight of the nine came off this line in one go — Math, Array,
// Vector, Word, TextIO, IO, Substring and General all exist now. `OS` stays,
// and stays for good: there is no operating system behind this, no file system
// and no processes, so `OS.FileSys.openDir` has nothing to open. An absence
// with a reason rather than a gap waiting to be filled.
const SKIPPED_STRUCTURES = ['OS'];
const SKIP_RE = new RegExp(`\\b(${SKIPPED_STRUCTURES.join('|')})\\.`);

function translate(d) {
  let s = d;
  // PRUNE THIS WHENEVER THE LANGUAGE GROWS. It has been out of date after every
  // single addition so far: it went on skipping modules and exceptions after
  // v1.252 added them, went on rewriting chars and `~` after v1.255 did, and
  // was still skipping `local`, `functor`, `ref` and the whole standard library
  // at v1.273 — all four of which v1.257 had added. Each time the score
  // under-reported and the gain was invisible.
  //
  // Every entry below was re-verified against the interpreter on 2026-08-06 by
  // running an example of it, not by reading the code. `local`, `functor`,
  // `ref`/`:=`, and the List/String/Int/Option structures all work and are no
  // longer skipped.
  //
  // v1.303: `infix`, `infixr`, `nonfix`, `open` and `abstype` came off this
  // line, and the warning above was right for the fifth time — `infix` landed
  // at L-E, `open` at v1.300 and `abstype` at v1.302, and the skip stayed put
  // through all three, so the score under-reported each time. Char and Real
  // were added to the prelude at v1.285 (L-G) and are likewise not skipped.
  // Everything still listed here has no implementation at all.
  if (SKIP_RE.test(s)) return null;

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


// ---- WHAT AN OUTCOME ACTUALLY IS -------------------------------------------
//
// One number was doing too many jobs. A declaration that this build REFUSES is
// not the same as one it cannot READ, and neither is the same as one that fails
// only because something earlier failed. Three findings forced the split, each
// checked against the corpus source rather than guessed:
//
//   1. Harper prints deliberate errors. typval.sml line 8 is four ill-typed
//      expressions in a row, put there to show a student what a type error
//      looks like. Refusing them is CORRECT, and the old scoring counted all
//      four against us.
//   2. `hd nil` raises. Standard ML raises too. Counting a raise as a failure
//      is counting agreement as disagreement.
//   3. Parts of the corpus are not valid Standard ML. parameterization.sml has
//      a LaTeX escape left in the source (`\_`), `None` for `NONE`, and a
//      constructor declared with three arguments and applied to four;
//      hierarchies.sml writes `= sig` where the language wants `struct`. These
//      are teaching listings and some have never been through a compiler.
//
// So 100% is not reachable and the ceiling is not a fact about this build. The
// report says what each failure IS and leaves the reading to whoever reads it.
//
// There is deliberately NO hand-kept list of "refusals that are correct". That
// is the departure register's lesson in reverse: a list nobody walks goes
// stale, and this one could not be walked, since deciding whether a refusal is
// right needs a reference implementation and there is none here.
const OUTCOME = {
  RAN:     'ran',
  RAISED:  'raised',      // ran, and raised, as Standard ML would
  TYPE:    'refused:type',  // MAY BE CORRECT — Harper's own errors land here
  PARSE:   'refused:parse', // never correct: this build could not read it
  CASCADE: 'cascade',       // failed on a name an earlier failure would have bound
  SKETCH:  'not in listing', // names something the file never defines at all
};

/** The names a declaration would have bound, had it worked. */
function bindsOf(src) {
  const out = [];
  const re = /\b(?:structure|functor|signature|datatype|type|exception|val|fun)\s+([A-Za-z_][\w']*)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  // `open X` puts X's members in scope, so a failed open makes bare names fail.
  const o = /\bopen\s+([A-Za-z_][\w']*)/.exec(src);
  if (o) out.push(o[1]);
  return out;
}

/** Classify one result, given the names earlier failures would have bound. */
function classify(text, orphaned, declared) {
  const t = String(text);
  if (!t.startsWith('ERR')) return OUTCOME.RAN;
  const msg = t.replace(/^ERR:\s*/, '');
  if (/^uncaught exception/.test(msg)) return OUTCOME.RAISED;
  // A missing name that an earlier failure would have supplied says nothing
  // about this declaration. One refused `structure` can otherwise account for
  // a dozen later failures and make the count look like a language problem.
  // Every wording this build uses for "there is no such name". Missing one
  // files a cascade as an independent failure, which is what the count was
  // doing for `no structure X to name`.
  const named = /(?:unbound variable[: ]*|no structure |)([A-Za-z_][\w'.]*)(?: is not a functor| to name| to open)|unbound variable[: ]*([A-Za-z_][\w'.]*)/.exec(msg);
  const who = named && String(named[1] || named[2]).split('.')[0];
  if (who && orphaned.has(who)) return OUTCOME.CASCADE;
  // A NAME THE FILE NEVER DEFINES. Harper's listings are sketches as often as
  // programs: subfun.sml writes `structure Key : ORDERED = StringLT` where
  // StringLT appears nowhere in the file, two lines above
  // `val insert = raise NotImplemented`. No implementation could run that, and
  // counting it as a gap in this one says nothing about this one.
  if (who && !declared.has(who)) return OUTCOME.SKETCH;
  if (/^(expected|unexpected|'.*' cannot start|.* cannot start)/.test(msg)) return OUTCOME.PARSE;
  return OUTCOME.TYPE;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sml')).sort();
const report = [];
for (const f of files) {
  const src = fs.readFileSync(`${DIR}/${f}`, 'utf8');
  const ds = decls(src);
  // LOAD THE LIBRARY. Until v1.285 this did not happen, so every declaration in
  // the corpus calling List.find or String.tokens failed on a name the build
  // actually had. The instrument must do what the thing it measures does.
  //
  // ADVISORY, not strict. The corpus is measured on whether the language can
  // READ and RUN each declaration; refusing well-formed code because inference
  // is incomplete here would measure the checker rather than the language, and
  // would move the number for a reason that has nothing to do with Harper.
  const interp = createInterpreter({ typecheck: 'off' });
  interp.loadPrelude();
  let attempted = 0, ok = 0, skipped = 0;
  const errs = [];
  const counts = { ran: 0, raised: 0, 'refused:type': 0, 'refused:parse': 0, cascade: 0, 'not in listing': 0 };
  // Names that a FAILED declaration in this file would have bound. Anything
  // later that trips over one of them is a consequence, not a finding.
  const orphaned = new Set();
  // Every name the FILE binds, gathered before scoring, so a reference to
  // something the listing never defines can be told from one this build cannot
  // find.
  const declared = new Set();
  for (const d of ds) {
    const t0 = translate(d);
    if (t0 !== null) for (const n of bindsOf(t0)) declared.add(n);
  }
  for (const d of ds) {
    const t = translate(d);
    if (t === null) { skipped++; continue; }
    attempted++;
    let r;
    try { r = interp.run(t); } catch (e) { r = { text: `ERR: ${e.message}` }; }
    const outcome = classify(r.text, orphaned, declared);
    counts[outcome]++;
    if (outcome === OUTCOME.RAN) ok++;
    else {
      for (const n of bindsOf(t)) orphaned.add(n);
      errs.push([t.slice(0, 52), outcome, String(r.text).replace(/^ERR:\s*/, '').slice(0, 40)]);
    }
  }
  report.push({ f, total: ds.length, attempted, ok, skipped, errs, counts });
}
for (const r of report) {
  const pct = r.attempted ? Math.round((r.ok / r.attempted) * 100) : 0;
  console.log(`${r.f.padEnd(22)} decls ${String(r.total).padStart(3)}  tried ${String(r.attempted).padStart(3)}  ran ${String(r.ok).padStart(3)} (${String(pct).padStart(3)}%)  skipped ${String(r.skipped).padStart(3)}`);
  const show = process.argv.includes('--verbose') ? r.errs.length : 3;
  for (const [t, o, e] of r.errs.slice(0, show)) console.log(`      × ${t}\n        [${o}] ${e}`);
}
const T = report.reduce((a, r) => ({ a: a.a + r.attempted, o: a.o + r.ok, s: a.s + r.skipped }), { a: 0, o: 0, s: 0 });
const C = report.reduce((a, r) => {
  for (const k of Object.keys(r.counts)) a[k] = (a[k] || 0) + r.counts[k];
  return a;
}, {});
console.log(`\nTOTAL attempted ${T.a}, ran ${T.o} (${Math.round(T.o / T.a * 100)}%), skipped as out-of-scope ${T.s}`);

// WHAT THE REST ARE. One number said only that a declaration did not run,
// which lumps a correct refusal in with a parse failure and counts one broken
// structure a dozen times over.
console.log('\nof the rest:');
console.log(`  raised          ${String(C.raised || 0).padStart(3)}   ran, and raised, as Standard ML does`);
console.log(`  refused: type   ${String(C['refused:type'] || 0).padStart(3)}   MAY BE CORRECT — Harper prints deliberate errors`);
console.log(`  refused: parse  ${String(C['refused:parse'] || 0).padStart(3)}   could not be read. Never correct: this is the real gap`);
console.log(`  cascade         ${String(C.cascade || 0).padStart(3)}   tripped over a name an earlier failure would have bound`);
console.log(`  not in listing  ${String(C['not in listing'] || 0).padStart(3)}   names something the file never defines. A sketch, not a program`);
console.log('\nThe corpus cannot reach 100%. Some of it is not valid Standard ML:');
console.log('parameterization.sml has a LaTeX escape left in the source and a');
console.log('constructor applied to four arguments where three were declared;');
console.log('hierarchies.sml writes `= sig` where the language wants `struct`.');
console.log('They are teaching listings, and some have never met a compiler.');

// This line goes stale every time the language grows, which is the whole
// history of the skip list above. Print the skip patterns themselves rather
// than a sentence describing them, so it cannot describe the wrong thing.
console.log(`\nSkipped as out of scope: declarations mentioning ${SKIPPED_STRUCTURES.join(', ')},`);
console.log('and any whose last token is `=` (the splitter cut them mid-declaration).');
// No pointer to a document here. This file ships in TWO repositories — NostOS,
// which has the Restrictions page and docs/ob-terminal-language.md, and BML,
// which has neither — and the line named both, so half the time it pointed at
// nothing. The skip list is right above; it is the document.
console.log(`Edit SKIPPED_STRUCTURES in ${import.meta.url.split('/').pop()} when one of them lands.`);

}
