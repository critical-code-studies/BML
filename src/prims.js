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

import { RonmlError, RonmlRaise } from './errors.js';

// Raise one of the standard exceptions BY NAME, carrying the sentence that
// says what went wrong.
//
// The messages here teach, which is the house style and worth keeping: "the
// list is empty. Check with length first." tells a beginner more than `Empty`
// does. But a message is not catchable, so `hd nil handle Empty => 0` had
// nothing to match and the house style was costing the language a feature it
// claimed to have. It answers both now: `handle Empty` sees an ordinary
// constructor, and an UNCAUGHT one still prints the sentence.
function raiseStd(name, why) {
  throw new RonmlRaise({ tag: 'con', name, args: [], why });
}
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
      if (!l.items.length) raiseStd('Empty', 'hd: the list is empty. Check with length first.');
      return l.items[0];
    },
  },
  tl: {
    arity: 1,
    fn: ([l]) => {
      if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`);
      if (!l.items.length) raiseStd('Empty', 'tl: the list is empty. Check with length first.');
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

  // ---- arrays and vectors --------------------------------------------------
  //
  // The only Basis types that cannot be built out of what the language has.
  // A list is immutable and copied, so `Array.update` written over a list would
  // be O(n) AND would not update anything anyone else is holding — which is the
  // entire point of an array. They need a real mutable place, so they are a
  // value tag of their own with a JavaScript array inside.
  //
  // Vector shares the machinery and differs in one rule, enforced by having no
  // update primitive at all rather than by checking a flag: there is no way to
  // write into one.
  arraymk: {
    arity: 2,
    fn: ([n, init]) => {
      if (!n || n.tag !== 'int') throw new RonmlError(`${describeValue(n)} is not a length`);
      if (n.v < 0) raiseStd('Size', `Array.array: ${n.v} is not a length. An array cannot be shorter than nothing.`);
      return { tag: 'array', items: new Array(n.v).fill(init) };
    },
  },
  arrayfromlist: {
    arity: 1,
    fn: ([l]) => {
      if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`);
      return { tag: 'array', items: l.items.slice() };
    },
  },
  arraysub: {
    arity: 2,
    fn: ([a, i]) => {
      if (!a || (a.tag !== 'array' && a.tag !== 'vector')) throw new RonmlError(`${describeValue(a)} is not an array`);
      if (!i || i.tag !== 'int') throw new RonmlError(`${describeValue(i)} is not an index`);
      if (i.v < 0 || i.v >= a.items.length) {
        raiseStd('Subscript', `sub: ${i.v} is outside an array of ${a.items.length}. The first is 0.`);
      }
      return a.items[i.v];
    },
  },
  arrayupdate: {
    arity: 3,
    fn: ([a, i, v]) => {
      if (!a || a.tag !== 'array') throw new RonmlError(`${describeValue(a)} cannot be updated`);
      if (!i || i.tag !== 'int') throw new RonmlError(`${describeValue(i)} is not an index`);
      if (i.v < 0 || i.v >= a.items.length) {
        raiseStd('Subscript', `update: ${i.v} is outside an array of ${a.items.length}. The first is 0.`);
      }
      a.items[i.v] = v;
      return { tag: 'unit' };
    },
  },
  arraylength: {
    arity: 1,
    fn: ([a]) => {
      if (!a || (a.tag !== 'array' && a.tag !== 'vector')) throw new RonmlError(`${describeValue(a)} is not an array`);
      return { tag: 'int', v: a.items.length };
    },
  },
  arraytolist: {
    arity: 1,
    fn: ([a]) => {
      if (!a || (a.tag !== 'array' && a.tag !== 'vector')) throw new RonmlError(`${describeValue(a)} is not an array`);
      return { tag: 'list', items: a.items.slice() };
    },
  },
  // A vector reads exactly as an array reads, and these run the same code. They
  // exist so the CHECKER can tell them apart: `Vector.length` was typed
  // `'a array -> int`, so every use of it on a real vector was refused, and
  // strict is the default. It ran, which is why nothing caught it.
  // THE CLOCK. Milliseconds since 1970, from the host or not at all.
  clocknow: {
    arity: 1,
    fn: (_args, ctx) => {
      const clock = ctx && ctx.clock;
      if (typeof clock !== 'function') {
        throw new RonmlError('this machine has no clock');
      }
      return { tag: 'int', v: Math.floor(clock()) };
    },
  },
  // Calendar parts from a count of milliseconds, in UTC. A function of its
  // argument and nothing else, which is why it can be a primitive at all: LOCAL
  // time would need a timezone, and a machine with no operating system has
  // none. `Date.fromTimeLocal` is therefore the same as `fromTimeUniv` here,
  // and says so.
  clockparts: {
    arity: 1,
    fn: ([ms]) => {
      if (!ms || ms.tag !== 'int') throw new RonmlError(`${describeValue(ms)} is not a time`);
      const d = new Date(ms.v);
      const parts = [
        d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCDay(),
      ];
      return { tag: 'tuple', items: parts.map((n) => ({ tag: 'int', v: n })) };
    },
  },
  vectorsub:    { arity: 2, fn: (args) => PRIMITIVES.arraysub.fn(args) },
  vectorlength: { arity: 1, fn: (args) => PRIMITIVES.arraylength.fn(args) },
  vectortolist: { arity: 1, fn: (args) => PRIMITIVES.arraytolist.fn(args) },
  vectorfromlist: {
    arity: 1,
    fn: ([l]) => {
      if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`);
      return { tag: 'vector', items: l.items.slice() };
    },
  },

  // ---- what Math needs -----------------------------------------------------
  //
  // `sqrt` was already here; the rest are the same shape. Written as primitives
  // rather than in BML because there is no way to compute a sine from the
  // arithmetic the language has, and a teaching implementation that cannot do
  // trigonometry cannot follow a textbook past chapter three.
  sin: mathfn('sin', Math.sin),
  cos: mathfn('cos', Math.cos),
  tan: mathfn('tan', Math.tan),
  asin: mathfn('asin', Math.asin),
  acos: mathfn('acos', Math.acos),
  atan: mathfn('atan', Math.atan),
  exp: mathfn('exp', Math.exp),
  ln: mathfn('ln', Math.log),
  log10: mathfn('log10', Math.log10),
  sinh: mathfn('sinh', Math.sinh),
  cosh: mathfn('cosh', Math.cosh),
  tanh: mathfn('tanh', Math.tanh),
  // TWO ARGUMENTS, and named apart from the Basis on purpose. A primitive of
  // arity 2 is CURRIED here, while `Math.pow` takes a tuple — and a structure
  // member shadows a top-level name of the same spelling, so `fun pow (x, y) =
  // pow x y` inside `structure Math` calls itself until the budget runs out.
  // That is the `makestring` lesson from v1.296, and it cost a debugging round
  // then. So the primitive is `mathpow` and `Math.pow` wraps it.
  mathatan2: {
    arity: 2,
    fn: ([a, b]) => {
      if (!numericTag(a) || !numericTag(b)) throw new RonmlError('atan2 needs two numbers');
      return { tag: 'real', v: Math.atan2(a.v, b.v) };
    },
  },
  mathpow: {
    arity: 2,
    fn: ([a, b]) => {
      if (!numericTag(a) || !numericTag(b)) throw new RonmlError('pow needs two numbers');
      return { tag: 'real', v: Math.pow(a.v, b.v) };
    },
  },

  // ---- rounding, the other three -------------------------------------------
  // `floor` was here alone. Standard ML has four, and they differ at the
  // halfway case and on negatives, which is exactly where somebody checking a
  // textbook answer will look.
  ceil: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'int', v: Math.ceil(n.v) }; } },
  trunc: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'int', v: Math.trunc(n.v) }; } },
  // Standard ML rounds to EVEN at a half, which JavaScript's Math.round does
  // not: Math.round(0.5) is 1 and Math.round(2.5) is 3, where SML gives 0 and 2.
  round: {
    arity: 1,
    fn: ([n]) => {
      if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`);
      const x = n.v;
      const f = Math.floor(x);
      const d = x - f;
      let r;
      if (d > 0.5) r = f + 1;
      else if (d < 0.5) r = f;
      else r = (f % 2 === 0) ? f : f + 1;   // a half goes to the even side
      return { tag: 'int', v: r };
    },
  },
};

// Every Math function of one real argument has the same body, so it is written
// once. Standard ML's Math takes and returns `real`; an int argument is
// accepted here and converted, because refusing `Math.sqrt 4` at a teaching
// prompt teaches nothing about mathematics.
function mathfn(name, f) {
  return {
    arity: 1,
    fn: ([n]) => {
      if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`);
      return { tag: 'real', v: f(n.v) };
    },
  };
}
