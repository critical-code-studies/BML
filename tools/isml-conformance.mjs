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

import { runRonml } from '../src/game/ai_ml.js';
import fs from 'fs';

// Split SML source into top-level declarations. Crude but adequate: a new
// declaration starts at column 0 with one of these words.
function decls(src) {
  src = src.replace(/\(\*[\s\S]*?\*\)/g, '');            // strip comments
  const lines = src.split('\n');
  const out = []; let cur = [];
  for (const l of lines) {
    if (/^(fun|val|datatype|type|exception|local|in|end|structure|signature|functor|infix|open|abstype)\b/.test(l) && cur.length) {
      out.push(cur.join('\n')); cur = [l];
    } else if (l.trim()) cur.push(l);
    else if (cur.length) { out.push(cur.join('\n')); cur = []; }
  }
  if (cur.length) out.push(cur.join('\n'));
  return out.map((d) => d.trim()).filter(Boolean);
}

// Mechanically translate the parts of SML that AI-ML spells differently.
// Clausal definitions become one `case`, which is the single biggest rewrite
// and the one Harper's own Restrictions note predicts.
function translate(d) {
  let s = d;
  // Pruned as the language grew. Modules, exceptions and type annotations were
  // skipped here until v1.252 added them; leaving them in the skip list would
  // have hidden the gain entirely, which is the third time this instrument has
  // been the thing that was out of date.
  if (/^(functor|infix|open|abstype|local)\b/.test(s)) return null;
  if (/\bref\b|:=/.test(s)) return null;                             // mutable cells
  if (/\b(String|List|Int|Real|Array|Vector|IO|TextIO)\./.test(s)) return null;


  s = s.replace(/#"(.)"/g, '"$1"');                                  // char -> 1-char string

  s = s.replace(/~(\d)/g, '(0 - $1)');                               // SML negation
  // Drop type annotations. The lookarounds matter: without them this eats the
  // second colon of `h::t` and every list pattern in the corpus turns to `h:`.
  // Type annotations are parsed now, so they are left alone. The stripper that
  // removed them is gone with them, and its lookaround bug with it.


  s = s.replace(/^fun\s+/, 'let ').replace(/^val\s+/, 'let ');

  s = s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  // SML spells equality `=`; this dialect spells it `==` because a single `=`
  // binds. Each CLAUSE has its own defining `=`, so convert per clause, after
  // the first one. Converting globally turned every second clause's defining
  // `=` into `==` and reported six files as failures that were fine.
  s = s.split(/\s\|\s/).map((clause) => {
    const eq = clause.indexOf('=');
    if (eq < 0) return clause;
    return clause.slice(0, eq + 1) + clause.slice(eq + 1).replace(/(?<![=<>])=(?![=>])/g, '==');
  }).join(' | ');
  if (/\b(=)\s*$/.test(s)) return null;
  return s;
}

const NAMES = ['ascription', 'clauses', 'concur', 'datatype', 'excs', 'fcnls', 'fcns',
  'hierarchies', 'io', 'lists', 'matching', 'memo', 'optexccont', 'parameterization',
  'perseph', 'prodpat', 'recfcn', 'recind', 'refs', 'regexp', 'repinv', 'seq', 'sharing',
  'sigstr', 'specs', 'streams', 'strind', 'subfun', 'typinf', 'typval', 'vardec', 'views'];
const DIR = 'tools/.isml-cache';
const BASE = 'https://www.cs.cmu.edu/~rwh/isml/examples';

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
  const ctx = { station: 'laptop', session: {} };
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

console.log('\nThe skipped ones are the documented absences: modules, exceptions,');
console.log('mutable references, the standard library. See the Restrictions page in');
console.log('the game, and docs/ob-terminal-language.md.');
