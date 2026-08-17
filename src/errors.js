// BML — a 2026 Standard ML. Part of NostOS; synced to the BML repository.
// Copyright (C) 2026 David M. Berry
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for details: <https://www.gnu.org/licenses/>.

// The errors the language can raise, shared by the lexer, the parser and the
// evaluator.
//
// These live in their own file rather than in lex.js because all three layers
// throw them and none of the three should have to import another just to say
// what went wrong. (The plan's file list in docs/PLAN.md does
// not name this file; it is the one addition M1 makes to that list.)

// Anything the language refuses, at any stage. The message is the one a player
// reads, so it is written for a person at a terminal rather than for a log.
export class RonmlError extends Error {}

// The budget ran out. Separate from RonmlError because a machine carrying a
// program that overruns is not showing an error message, it is FAULTING, and
// the caller wants to tell the two apart.
export class RonmlFuelError extends RonmlError {}

// A raised exception in flight. Not a RonmlError: an uncaught one is reported
// as one, but on the way up it is a value being carried, not a failure.
export class RonmlRaise extends Error {
  constructor(value) { super('uncaught exception'); this.value = value; }
}

// The program asked to read a line and there is none queued. Not a failure:
// the run is SUSPENDED, and whether it can resume is the host's business. A
// console with somebody sitting at it collects a line, puts it on the queue and
// runs the program again from the top; a headless host that has already handed
// over everything it has treats this as end of input.
//
// It is not a RonmlError, for the same reason RonmlRaise is not: on the way up
// it is a request, and only the outermost caller decides whether it is a fault.
export class RonmlNeedInput extends Error {
  constructor() { super('waiting for input'); }
}
