// The errors the language can raise, shared by the lexer, the parser and the
// evaluator.
//
// These live in their own file rather than in lex.js because all three layers
// throw them and none of the three should have to import another just to say
// what went wrong. (The plan's file list in docs/aiml-standalone-plan.md does
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
