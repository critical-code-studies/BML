// THE PRIMITIVES. The parts of the Basis that cannot be written in BML.
//
// Part of src/lang/. Written at v1.288 (M4).
//
// WHY THIS FILE EXISTS, and it is the best thing the extraction has turned up.
// These functions lived in NostOS's laptop verb table, beside `scan` and
// `hack`, because that is where they were first needed. They are not game
// verbs: `hd`, `explode` and `ord` are Standard ML, and basis.js CALLS them —
// `String.size` is `length (explode s)`, `Char.isDigit` is `ord c >= 48`. So
// the language could not load its own library without the game attached, and
// nothing noticed until M4 pointed the conformance harness at src/lang/ and the
// score fell eight declarations.
//
// The rule this settles: if the prelude can call it, it belongs to the
// language. Everything that reaches into the world — scan, hack, the sensors,
// the machine's own effects — stays a host verb, supplied through
// createInterpreter's `builtins`.
//
// A host may still override any of these by name; NostOS does not, but the
// merge order in interp.js lets it.

import { RonmlError } from './errors.js';
import { describeValue, formatValue, pushOut } from './eval.js';

const numericTag = (x) => !!x && (x.tag === 'int' || x.tag === 'real');

export const PRIMITIVES = {
  // ANY value as the text it prints as. The prelude used to write `"" ^ n` for
  // this, leaning on the fact that `^` coerces at runtime. The checker types
  // `^` as string-only, which is what Standard ML says it is, so `Int.toString`
  // inferred `string -> string` and `Int.toString 42` was an error under strict.
  // A conversion needs to be a conversion.
  // Named after Poly/ML's `PolyML.makestring`, which is this exact function.
  // Not called `toString`, because the structures define their own `toString`
  // and a member shadows a top-level name of the same spelling: the first
  // attempt wrote `fun toString n = toString n` and recursed until the budget
  // ran out.
  makestring: {
    arity: 1,
    fn: ([v]) => ({ tag: 'str', v: formatValue(v) }),
  },
  // The one way to print. The buffer it writes into is in eval.js, because a
  // closure captures the ctx of the line that defined it and a per-ctx buffer
  // swallowed output from any function called on a later line. The buffer moved
  // out in M2 and this was left behind in the game's verb table, so for one
  // version the language had somewhere to print and no way to do it.
  echo: {
    arity: 1,
    fn: ([x]) => {
      pushOut(formatValue(x));
      return { tag: 'unit' };
    },
  },
  hd: {
    arity: 1,
    fn: ([l]) => {
      if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`);
      if (!l.items.length) throw new RonmlError('hd: the list is empty. Check with length first.');
      return l.items[0];
    },
  },
  tl: {
    arity: 1,
    fn: ([l]) => {
      if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`);
      if (!l.items.length) throw new RonmlError('tl: the list is empty. Check with length first.');
      return { tag: 'list', items: l.items.slice(1) };
    },
  },
  length: {
    arity: 1,
    fn: ([l]) => {
      if (l && l.tag === 'str') return { tag: 'int', v: String(l.v).length };
      if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} has no length`);
      return { tag: 'int', v: l.items.length };
    },
  },
  not: {
    arity: 1,
    fn: ([b]) => {
      if (!b || b.tag !== 'bool') throw new RonmlError(`${describeValue(b)} is not true or false`);
      return { tag: 'bool', v: !b.v };
    },
  },
  abs: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: n.tag, v: Math.abs(n.v) }; } },
  sqrt: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); if (n.v < 0) throw new RonmlError('sqrt of a negative'); return { tag: 'real', v: Math.sqrt(n.v) }; } },
  real: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'real', v: n.v }; } },
  floor: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'int', v: Math.floor(n.v) }; } },
  ord: { arity: 1, fn: ([c]) => { if (!c || c.tag !== 'char') throw new RonmlError(`${describeValue(c)} is not a character`); return { tag: 'int', v: c.v.charCodeAt(0) }; } },
  chr: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'char', v: String.fromCharCode(n.v) }; } },
  str: { arity: 1, fn: ([c]) => { if (!c || c.tag !== 'char') throw new RonmlError(`${describeValue(c)} is not a character`); return { tag: 'str', v: c.v }; } },
  explode: { arity: 1, fn: ([x]) => { if (!x || x.tag !== 'str') throw new RonmlError(`${describeValue(x)} is not a string`); return { tag: 'list', items: [...x.v].map((ch) => ({ tag: 'char', v: ch })) }; } },
  implode: { arity: 1, fn: ([l]) => { if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`); return { tag: 'str', v: l.items.map((c) => (c && c.tag === 'char' ? c.v : formatValue(c))).join('') }; } },
  min: { arity: 2, fn: ([a, b]) => { if (!a || !numericTag(a) || !b || !numericTag(b)) throw new RonmlError('min needs two numbers'); return { tag: a.tag, v: Math.min(a.v, b.v) }; } },
  max: { arity: 2, fn: ([a, b]) => { if (!a || !numericTag(a) || !b || !numericTag(b)) throw new RonmlError('max needs two numbers'); return { tag: a.tag, v: Math.max(a.v, b.v) }; } },
  size: { arity: 1, fn: ([x]) => { if (x && x.tag === 'str') return { tag: 'int', v: x.v.length }; if (x && x.tag === 'list') return { tag: 'int', v: x.items.length }; throw new RonmlError(`${describeValue(x)} has no size`); } },
  ref: { arity: 1, fn: ([v]) => ({ tag: 'ref', cell: { v } }) },
};
