// BML — a 2026 Standard ML. Part of NostOS; synced to the BML repository.
// Copyright (C) 2026 David M. Berry
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for details: <https://www.gnu.org/licenses/>.

// BML — a 2026 Standard ML. The public surface.
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
export { parse, parseLine, joinProgram, joinProgramLines, needsMoreInput, continuesPrevious, defaultFixity } from './parse.js';
export { formatValue, showReal, describeValue, setHostValues, CONSOLE_FUEL } from './eval.js';
export { typeOf, remember } from './types.js';
export { diagnose, NOT_FITTED_SAMPLES } from './diag.js';
export { PRELUDE } from './basis.js';
export { complete, readlineCompleter, commonPrefix, COMPLETION_KEYWORDS } from './complete.js';

export const BML_NAME = 'BML';

// 0.1.0, and starting there is the point. The language carries a longer
// history than that and `git log` has it, but a version number on a package
// means one specific thing: how stable the API is. `createInterpreter` is days
// old and its contract has already changed three times (the return dropped
// `value`, then gained `printing`, then `primitives`), so 2.7 would have
// claimed two major versions of a settled interface that has never existed.
// The language's own lineage belongs in the history and the README, not here.
export const BML_VERSION = '0.40.0';

export const BML_CREDIT = [
  'BML created by David M. Berry, 2026.',
  'Based on Standard ML developed by Robin Milner, Mads Tofte, and',
  'Robert Harper. Many thanks to Robert Harper for the inspiration in',
  'his book "Introduction to Standard ML" (1986), and to Åke Wikström for',
  '"Functional Programming Using Standard ML" (1987).',
];
