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
  [/\b(Word|Array|Vector|IO|TextIO|OS|Math|Substring|General)\./, 'that library is not on this machine. ml -full lists what is.'],
  [/^\s*abstype\b/, 'no abstype on this build.'],
];

// The samples the test uses, one per rule above, in the same order.
// One sample per rule in NOT_FITTED, walked by a test that checks each is
// still genuinely refused. `Char.ord c` left this list at v1.285, when the
// prelude gained Char and Real; `Array.sub` replaces it as a structure that
// really is absent.
export const NOT_FITTED_SAMPLES = ['Array.sub (a, 0)', 'abstype t = A with val z = A end'];

export function diagnose(src) {
  for (const [re, why] of NOT_FITTED) if (re.test(src)) return why;
  return null;
}
