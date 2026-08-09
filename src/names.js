// BML — a 2026 Standard ML. Part of NostOS; synced to the BML repository.
// Copyright (C) 2026 David M. Berry
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for details: <https://www.gnu.org/licenses/>.

// How a name is turned into the key it is stored and looked up under.
//
// Part of src/lang/. Written at v1.306.
//
// STANDARD ML IS CASE-SENSITIVE. `foo` and `Foo` are two names, and the
// distinction carries weight: the convention that constructors are capitalised
// and variables are not is a convention only because the two can differ. This
// build lower-cased every identifier, so `val foo = 1; val Foo = 2` left one
// name holding 2, and `exception Size` could not be declared at all because it
// collided with the `size` function — five tests went red on that one line.
//
// NostOS needs the opposite. Its terminals are 1980s machines and a player
// types `HACK OB_1A2B` as readily as `hack ob_1a2b`; the whole surface has
// always folded case, and taking that away would change the game rather than
// fix it.
//
// So it is a host policy, like `setHostUnbound` and `setHostKnowsName`: the
// language does what the Definition says, and a host that wants something else
// asks for it. `createInterpreter({ names: 'fold' })` folds; the default is
// 'exact'.
//
// MODULE-LEVEL, and deliberately, for the same reason the step counter and the
// print buffer are: this is consulted from every corner of the evaluator, the
// parser and the checker, and threading it through each of them would mean
// touching every recursive call in three files. The cost is that one process
// runs one policy. The game sets it at import time and never changes it; BML
// never sets it at all. `node --test` gives each test file its own process, so
// the game's tests and the language's do not collide.

let FOLD = false;

/** Ask for case-folded names (the game) or exact ones (Standard ML). */
export function setNameFold(on) { FOLD = !!on; }

/** Is case being folded? For a host that needs to know what it asked for. */
export function nameFolding() { return FOLD; }

/**
 * The key a name is stored under. Under 'exact' this is the name itself, so
 * `Foo` and `foo` are two bindings; under 'fold' they are one.
 */
export function nameKey(n) {
  const s = String(n);
  return FOLD ? s.toLowerCase() : s;
}

/**
 * Whether a word is a given KEYWORD. Standard ML's keywords are lower-case and
 * nothing else: `IF` is an ordinary name there. Under folding, `IF` is `if`,
 * which is what a NostOS terminal has always accepted.
 */
export function keywordEq(word, kw) {
  const s = String(word);
  return FOLD ? s.toLowerCase() === kw : s === kw;
}
