// BML — a little Standard ML. The public surface.
//
// This is the file a host imports. Everything reachable from here is the
// language; nothing here knows about NostOS. When src/lang/ is split out to
// its own repository (docs/aiml-standalone-plan.md §5) this becomes that
// repository's entry point unchanged.
//
// The in-fiction name inside NostOS stays AI-ML, and the adapter keeps its own
// version banner and its own wording for `ml -ver`. The names below are the
// language's own.

export { createInterpreter, smlEcho, flattenSession } from './interp.js';
export { RonmlError, RonmlFuelError, RonmlRaise } from './errors.js';
export { tokenize } from './lex.js';
export { parse, parseLine, joinProgram, joinProgramLines, defaultFixity } from './parse.js';
export { formatValue, describeValue, CONSOLE_FUEL } from './eval.js';
export { typeOf, remember } from './types.js';
export { diagnose, NOT_FITTED_SAMPLES } from './diag.js';
export { PRELUDE } from './basis.js';

export const BML_NAME = 'BML';

// The number continues AI-ML's rather than restarting, because it is the same
// language: the history in the NostOS repository is this language's history,
// and a fresh 0.1.0 would throw that away to look new.
export const BML_VERSION = '2.7';

export const BML_CREDIT = [
  'BML created by David M. Berry, 2026.',
  'Based on Standard ML developed by Robin Milner, Mads Tofte, and',
  'Robert Harper. Many thanks to Robert Harper for the inspiration in',
  'his book "Introduction to Standard ML" (1986), and to Åke Wikström for',
  '"Functional Programming Using Standard ML" (1987).',
];
