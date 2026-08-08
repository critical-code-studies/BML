// DIAGNOSTICS. What to say when a line uses a piece of Standard ML this build
// does not have.
//
// Part of src/lang/. Moved out of src/game/ai_ml.js at v1.288 (M3).
//
// This list fires BEFORE the parser's own message, because the parser's message
// for a signature block names the colon it choked on, which helps nobody. That
// also makes it dangerous: a rule left here after the feature lands hides the
// real error. A test walks NOT_FITTED_SAMPLES and asserts each is still
// genuinely refused, which is the only thing that has ever kept it honest.

const NOT_FITTED = [
  // A test walks this list and asserts every pattern here still FAILS to parse.
  // That is the only thing that has stopped it going stale: it went on refusing
  // modules, exceptions, chars, local and refs after each of them shipped, six
  // times, and every time it fired before the parser and hid the real error.
  // `infix`/`infixr`/`nonfix`/`op` were here until v1.277 added them, and
  // String/List/Int/Option were here until v1.257 added them. Both pruned by
  // the test below, which is the only thing that has ever kept this honest.
  // ONLY the structures that are genuinely absent. Word, Array, Vector, IO,
  // TextIO, Math, Substring and General were on this line long after they
  // landed, so a bad MEMBER of a present structure — `Math.map` — was reported
  // as a missing library. Exactly what the note above warns about, and it took
  // a user typing `date` to notice.
  [/\bOS\./, 'that library is not on this machine. ml -full lists what is.'],
];

// The samples the test uses, one per rule above, in the same order.
// One sample per rule in NOT_FITTED, walked by a test that checks each is
// still genuinely refused. `Char.ord c` left this list at v1.285, when the
// prelude gained Char and Real; `Array.sub` replaces it as a structure that
// really is absent.
export const NOT_FITTED_SAMPLES = ['OS.getEnv "HOME"'];

// WHAT TO SAY INSTEAD OF "unbound variable: date".
//
// A name that is not bound is usually one of three things, and the machine can
// tell which: a word from another language, the right name in the wrong case,
// or a near-miss typing. Standard ML is case-sensitive, so `date` and `Date`
// are two names and a reader who typed the first meant the second.
// A word from another language maps either to the ML WORD for it (one token,
// printed as "Standard ML writes X") or to a whole sentence, when the honest
// answer is that ML does not have the idea at all.
const FROM_ELSEWHERE = {
  var: 'val', const: 'val', let: 'val', function: 'fun', def: 'fun',
  lambda: 'fn', struct: 'structure', elif: 'else if',
  switch: 'case', match: 'case',
  import: 'open', require: 'open',
  'return': 'there is nothing to return: a function IS its last expression',
  'null': 'the empty list is nil, and a missing value is NONE',
  'undefined': 'a missing value is NONE',
  'begin': 'a block is let … in … end',
  'printf': 'print takes a string: print "hello\\n"',
  'console': 'print writes a line',
};

/**
 * One edit apart? Insertion, deletion, substitution, or a swap of neighbours —
 * the last because it is the commonest slip and the one people least expect a
 * machine to see through (`lenght` for `length`).
 */
function withinOneEdit(a, b) {
  if (a === b) return true;
  const d = a.length - b.length;
  if (d > 1 || d < -1) return false;
  if (d === 0) {
    const at = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) at.push(i);
    if (at.length === 1) return true;
    // A swap shows up as two adjacent disagreements that read across.
    return at.length === 2 && at[1] === at[0] + 1
      && a[at[0]] === b[at[1]] && a[at[1]] === b[at[0]];
  }
  const long = d === 1 ? a : b;
  const short = d === 1 ? b : a;
  let i = 0, j = 0, slack = 1;
  while (i < long.length && j < short.length) {
    if (long[i] === short[j]) { i++; j++; continue; }
    if (!slack--) return false;
    i++;
  }
  return true;
}

export function suggestName(name, known = []) {
  // A qualified name misses on its STRUCTURE far more often than on its member,
  // and the structure is the part a reader can check.
  const dot = String(name).indexOf('.');
  if (dot > 0) {
    const head = String(name).slice(0, dot);
    const on = suggestName(head, known);
    return on ? on.replace('did you mean', 'there is no structure ' + head + ' — did you mean') : null;
  }
  const elsewhere = FROM_ELSEWHERE[String(name).toLowerCase()];
  if (elsewhere) {
    return elsewhere.includes(' ')
      ? `${name} is another language's word — ${elsewhere}`
      : `${name} is another language's word — Standard ML writes ${elsewhere}`;
  }

  const lower = String(name).toLowerCase();
  // Case first, because it is the likeliest and the surest: Standard ML tells
  // `date` and `Date` apart, and the reader who typed one meant the other.
  const cased = known.find((k) => k !== name && k.toLowerCase() === lower);
  if (cased) return `did you mean ${cased}? Standard ML tells capitals apart`;

  const near = known.find((k) => k !== name && withinOneEdit(String(k), String(name)));
  if (near) return `did you mean ${near}?`;
  return null;
}

// A line that is not finished. These fire only after something has already
// failed to parse, and each shape is one that is NEVER valid however it ends,
// so none of them can hide a real error the way a not-fitted rule can.
//
// The parser's own words for these name the token it stopped on — "expected eq,
// got 'EOF'" — which tells a reader what the parser wanted, not what they left
// out.
const UNFINISHED = [
  [/^\s*val\s+[A-Za-z_][\w']*\s*:\s*[\w'. *()>-]+$/,
   'a val binding needs a value as well as a type: val d : int = 0'],
  [/^\s*val\s+[A-Za-z_][\w']*\s*$/,
   'a val binding needs a value: val d = 0'],
  [/^\s*fun\s+[A-Za-z_][\w']*(\s+[A-Za-z_(][\w')]*)*\s*$/,
   'a fun binding needs a body: fun f x = x'],
];

export function diagnose(src) {
  for (const [re, why] of NOT_FITTED) if (re.test(src)) return why;
  for (const [re, why] of UNFINISHED) if (re.test(src)) return why;
  return null;
}
