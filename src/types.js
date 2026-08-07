// TYPE INFERENCE FOR AI-ML.
//
// Hindley-Milner, over the AST that ai_ml.js already builds: unification with
// an occurs check, let-polymorphism by generalising at a binding, and fresh
// instantiation at every use. It is the same algorithm the language this one
// descends from uses, and it is here because the reason previously given for
// not having it was wrong. The claim was that inference needs a whole program
// and a console has one line at a time. Standard ML's own top level disproves
// that: it infers and prints a type for every declaration you enter, which is
// how the manuals display everything. There was no barrier. There was no
// implementation.
//
// WHAT IT IS FOR HERE. It reports rather than refuses: it names the type of
// what you bound, and names a clash when it finds one. Whether a clash stops
// the line is the caller's decision, not this module's.
//
// Pure. No world, no DOM, no console.

// ---- the representation ----------------------------------------------------
//
// A type is either a variable, which may or may not be bound to something yet,
// or a constructor applied to arguments. Lists, tuples, functions and records
// are all constructors, which is why the representation is shaped this way.

let NEXT = 0;

import { nameKey } from './names.js';

export function fresh() { return { k: 'var', id: NEXT++, ref: null }; }
export function con(name, args = []) { return { k: 'con', name, args }; }

export const INT = con('int');
export const REAL = con('real');
export const CHAR = con('char');
// Kept as a name for the places that only care that it is a number.
export const NUM = INT;
// `string`, which is its name in Standard ML. It printed as `str` until v1.290,
// so `explode` reported `str -> char list` where SML says `string -> char list`.
// The TAG on a runtime value is still 'str'; this is only what the type is
// called when a type is printed.
export const STR = con('string');
export const BOOL = con('bool');
export const UNIT = con('unit');
export const listOf = (t) => con('list', [t]);
export const fnOf = (a, b) => con('->', [a, b]);
export const tupleOf = (ts) => con('*', ts);
export const refOf = (t) => con('ref', [t]);

// Follow a variable to whatever it has been bound to. Everything below assumes
// its inputs have been pruned, which is why almost every function starts here.
export function prune(t) {
  if (t.k === 'var' && t.ref) {
    t.ref = prune(t.ref);   // path compression: the chains get long otherwise
    return t.ref;
  }
  return t;
}

function occurs(v, t) {
  const p = prune(t);
  if (p === v) return true;
  if (p.k === 'con') return p.args.some((a) => occurs(v, a));
  return false;
}

export class TypeError_ extends Error {}

export function unify(a, b) {
  const x = prune(a);
  const y = prune(b);
  if (x === y) return;
  if (x.k === 'var') {
    // The occurs check is what stops `fn x => x x` from building an infinite
    // type and hanging the console instead of reporting.
    if (occurs(x, y)) throw new TypeError_('this would need an infinite type');
    x.ref = y;
    return;
  }
  if (y.k === 'var') return unify(y, x);
  if (x.name !== y.name || x.args.length !== y.args.length) {
    throw new TypeError_(`${show(x)} and ${show(y)} are not the same type`);
  }
  for (let i = 0; i < x.args.length; i++) unify(x.args[i], y.args[i]);
}

// ---- schemes and environments ----------------------------------------------
//
// A scheme is a type with some of its variables marked as "fresh at every use",
// which is what makes one `map` usable on numbers and on strings. Only the
// variables not free in the environment may be generalised.

const scheme = (vars, type) => ({ vars, type });
const mono = (type) => scheme([], type);

function freeVars(t, into = new Set()) {
  const p = prune(t);
  if (p.k === 'var') into.add(p.id);
  else p.args.forEach((a) => freeVars(a, into));
  return into;
}

function envFree(env) {
  const out = new Set();
  for (const s of Object.values(env)) {
    const bound = new Set(s.vars);
    for (const id of freeVars(s.type)) if (!bound.has(id)) out.add(id);
  }
  return out;
}

// THE VALUE RESTRICTION. Standard ML generalises a binding only when its
// right-hand side is a syntactic value: a literal, a variable, a lambda, or a
// constructor applied to values. An application is not one, so `val r = ref nil`
// keeps its type variable un-generalised and cannot be used at two types. Without
// this rule the reported type of a cell is a lie: it would say `'a list ref` and
// then let you put an int in and take a string out.
function isSyntacticValue(node) {
  if (!node) return false;
  switch (node.type) {
    case 'Lit': case 'StrLit': case 'CharLit': case 'Unit':
    case 'Var': case 'Lam':
      return true;
    case 'Tuple': return (node.items || []).every(isSyntacticValue);
    case 'ListLit': return (node.items || []).every(isSyntacticValue);
    case 'Record': return (node.fields || []).every((f) => isSyntacticValue(f.value));
    default: return false;   // App, Deref, Assign, If, Case, Let: not values
  }
}

function generalise(env, t) {
  const inEnv = envFree(env);
  const vars = [...freeVars(t)].filter((id) => !inEnv.has(id));
  return scheme(vars, t);
}

function instantiate(s) {
  if (!s.vars.length) return s.type;
  const map = new Map(s.vars.map((id) => [id, fresh()]));
  const go = (t) => {
    const p = prune(t);
    if (p.k === 'var') return map.get(p.id) || p;
    return con(p.name, p.args.map(go));
  };
  return go(s.type);
}

// ---- printing --------------------------------------------------------------
//
// SML's own notation, because the point is that a reader who knows ML can read
// it. `num` rather than `int`: this language has one number type.

export function show(t, names = new Map()) {
  const p = prune(t);
  if (p.k === 'var') {
    if (!names.has(p.id)) names.set(p.id, `'${String.fromCharCode(97 + (names.size % 26))}`);
    return names.get(p.id);
  }
  if (p.name === '->') return `${showArg(p.args[0], names)} -> ${show(p.args[1], names)}`;
  if (p.name === '*') return p.args.map((a) => showArg(a, names)).join(' * ');
  if (p.name === 'list') return `${showArg(p.args[0], names)} list`;
  if (p.name === 'record') {
    return `{${p.labels.map((l, i) => `${l} : ${show(p.args[i], names)}`).join(', ')}}`;
  }
  if (!p.args.length) return p.name;
  // Standard ML brackets a type constructor's arguments once there is more
  // than one: `(int, string) pair`, and plain `int box` for a single one.
  if (p.args.length > 1) return `(${p.args.map((a) => show(a, names)).join(', ')}) ${p.name}`;
  return `${showArg(p.args[0], names)} ${p.name}`;
}

function showArg(t, names) {
  const p = prune(t);
  const s = show(p, names);
  return (p.k === 'con' && (p.name === '->' || p.name === '*')) ? `(${s})` : s;
}

export function recordOf(labels, types) {
  const c = con('record', types);
  c.labels = labels;
  return c;
}

// ---- what the builtins are -------------------------------------------------
//
// Only the language's own verbs are typed. The station verbs (scan, hack, the
// machine senses) are left polymorphic on purpose: they reach into a world this
// module knows nothing about, so a type for them would be a guess. A fresh
// variable says "anything", which is accurate.
function baseEnv() {
  const a = fresh();
  const b = fresh();
  return {
    hd: scheme([a.id], fnOf(listOf(a), a)),
    tl: scheme([a.id], fnOf(listOf(a), listOf(a))),
    length: scheme([a.id], fnOf(listOf(a), NUM)),
    not: mono(fnOf(BOOL, BOOL)),
    abs: scheme([a.id], fnOf(a, a)),
    sqrt: mono(fnOf(REAL, REAL)),
    min: scheme([a.id], fnOf(a, fnOf(a, a))),
    max: scheme([a.id], fnOf(a, fnOf(a, a))),
    real: mono(fnOf(INT, REAL)),
    floor: mono(fnOf(REAL, INT)),
    ord: mono(fnOf(CHAR, INT)),
    makestring: scheme([a.id], fnOf(a, STR)),
    chr: mono(fnOf(INT, CHAR)),
    str: mono(fnOf(CHAR, STR)),
    explode: mono(fnOf(STR, listOf(CHAR))),
    implode: mono(fnOf(listOf(CHAR), STR)),
    size: scheme([b.id], fnOf(b, NUM)),
    echo: scheme([b.id], fnOf(b, UNIT)),
    // A cell. `ref` makes one, `!` reads it, `:=` writes it — the three of them
    // are the only way anything in this language changes, so they are worth
    // typing properly rather than leaving as "anything".
    ref: scheme([a.id], fnOf(a, refOf(a))),

    // THE MATH PRIMITIVES. Real to real, every one of them. Missing from here,
    // they took the unknown-name path and `Math.sqrt 4.0` reported `'a` for a
    // value that is a real and nothing else. `sqrt` was already listed; the
    // rest arrived at v1.306 and this list did not move with them, which is the
    // same shape as every other stale list in this project.
    sin: mono(fnOf(REAL, REAL)),
    cos: mono(fnOf(REAL, REAL)),
    tan: mono(fnOf(REAL, REAL)),
    asin: mono(fnOf(REAL, REAL)),
    acos: mono(fnOf(REAL, REAL)),
    atan: mono(fnOf(REAL, REAL)),
    exp: mono(fnOf(REAL, REAL)),
    ln: mono(fnOf(REAL, REAL)),
    log10: mono(fnOf(REAL, REAL)),
    sinh: mono(fnOf(REAL, REAL)),
    cosh: mono(fnOf(REAL, REAL)),
    tanh: mono(fnOf(REAL, REAL)),
    mathpow: mono(fnOf(REAL, fnOf(REAL, REAL))),
    mathatan2: mono(fnOf(REAL, fnOf(REAL, REAL))),
    ceil: mono(fnOf(REAL, INT)),
    trunc: mono(fnOf(REAL, INT)),
    round: mono(fnOf(REAL, INT)),

    // ARRAYS AND VECTORS. `array` and `vector` are type constructors of one
    // argument, like `list`, so `Array.fromList [1,2,3]` is `int array` and
    // `Array.sub` on it is `int`.
    arraymk: scheme([a.id], fnOf(INT, fnOf(a, con('array', [a])))),
    arrayfromlist: scheme([a.id], fnOf(listOf(a), con('array', [a]))),
    vectorfromlist: scheme([a.id], fnOf(listOf(a), con('vector', [a]))),
    arraysub: scheme([a.id], fnOf(con('array', [a]), fnOf(INT, a))),
    arrayupdate: scheme([a.id], fnOf(con('array', [a]), fnOf(INT, fnOf(a, UNIT)))),
    arraylength: scheme([a.id], fnOf(con('array', [a]), INT)),
    arraytolist: scheme([a.id], fnOf(con('array', [a]), listOf(a))),
  };
}

// ---- inference -------------------------------------------------------------

// EXHAUSTIVENESS. A case that does not cover every shape its subject can take is
// a program with a hole in it, and the hole only shows when the value that falls
// through it turns up. On a machine that is a unit standing in a field with an
// amber lamp; on this laptop it is a line of warning while you can still do
// something about it. Standard ML reports the same thing at compile time.
//
// An arm that is a wildcard or a plain variable catches everything, so any case
// with one of those is exhaustive whatever else it has.
function checkExhaustive(subject, arms, cons) {
  const irrefutable = (p) => p.p === 'wild'
    || (p.p === 'name' && !p.args.length && !cons[p.name] && !/^[A-Z]/.test(p.name));
  if (arms.some((a) => irrefutable(a.pat))) return;

  const t = prune(subject);
  if (t.k !== 'con') return;             // unknown shape: nothing to say

  if (t.name === 'list') {
    const hasNil = arms.some((a) => a.pat.p === 'nil');
    const hasCons = arms.some((a) => a.pat.p === 'cons');
    if (hasNil && !hasCons) WARNINGS.push('this case does not cover a non-empty list');
    else if (hasCons && !hasNil) WARNINGS.push('this case does not cover nil');
    return;
  }

  const all = (CURRENT_DATACONS || {})[t.name];
  if (!all || !all.length) return;
  const covered = new Set(arms.map((a) => (a.pat.p === 'name' ? a.pat.name : null)).filter(Boolean));
  const missing = all.filter((c) => !covered.has(c));
  if (missing.length) {
    WARNINGS.push(`this case does not cover ${missing.join(', ')}`);
  }
}

// The datatype-to-constructors map for the line being inferred. Set by typeOf.
let CURRENT_DATACONS = {};
// The functor bodies this session has declared, so an application can infer one
// again against its actual argument. Filled from the session in typeOf, the
// same way CURRENT_DATACONS is.
let CURRENT_FUNCTORS = {};
// The type ABBREVIATIONS this session has declared, as {params, rhs}. An
// annotation naming one is expanded against it, so `int syn` becomes
// `int list` and can then be checked like any other type.
let CURRENT_ABBREVS = {};
// Arity per constructor, so the App case can recognise the tuple form.
let CURRENT_CONARITY = {};

function inferPattern(pat, binds, cons) {
  switch (pat.p) {
    case 'wild': return fresh();
    case 'num': return pat.real ? REAL : INT;
    case 'char': return CHAR;
    case 'str': return STR;
    case 'bool': return BOOL;
    case 'nil': return listOf(fresh());
    case 'cons': {
      const h = inferPattern(pat.head, binds, cons);
      const t = inferPattern(pat.tail, binds, cons);
      unify(t, listOf(h));
      return t;
    }
    case 'tuple': return tupleOf(pat.items.map((p) => inferPattern(p, binds, cons)));
    case 'record': {
      const labels = pat.fields.map((f) => f.label);
      const types = pat.fields.map((f) => inferPattern(f.pat, binds, cons));
      return recordOf(labels, types);
    }
    case 'as': {
      const t = inferPattern(pat.pat, binds, cons);
      binds[nameKey(pat.name)] = t;
      return t;
    }
    case 'ann': {
      const t = inferPattern(pat.pat, binds, cons);
      unify(t, fromAnnotation(pat.ann, new Map()));
      return t;
    }
    case 'name': {
      const c = cons[pat.name];
      if (c) {
        // A constructor pattern: its arguments must match what it was declared
        // to carry, and the whole thing has the datatype's type.
        const inst = instantiate(c);
        let t = inst;
        // The same two spellings the expression side accepts: `N (l, v, r)` is
        // Standard ML's, one argument that is a tuple, and `N l v r` is this
        // build's curried form. A pattern arrives as ONE arg holding a tuple in
        // the first case, so peeling a single arrow off a three-argument
        // constructor left `'b -> 'c -> t` where `t` was wanted. Fixing this on
        // the expression side alone was not enough: a clausal `fun` matches on
        // the pattern before it builds anything.
        const arity = CURRENT_CONARITY[pat.name];
        const args = (arity > 1 && pat.args.length === 1 && pat.args[0] && pat.args[0].p === 'tuple'
                      && pat.args[0].items.length === arity)
          ? pat.args[0].items
          : pat.args;
        for (const arg of args) {
          const at = inferPattern(arg, binds, cons);
          const res = fresh();
          unify(t, fnOf(at, res));
          t = res;
        }
        return t;
      }
      const v = fresh();
      binds[nameKey(pat.name)] = v;
      return v;
    }
    default: return fresh();
  }
}

const NUMERIC = new Set(['PLUS', 'MINUS', 'STAR', 'SLASH', 'MOD', 'DIV']);

// `+` works on int and on real but on nothing else, and plain Hindley-Milner
// has no way to say that. Standard ML resolves the same problem by defaulting
// an unresolved arithmetic operand to int, and so does this: still a variable
// means nothing has decided, so decide int; anything that is not a number is a
// clash and is reported as one.
function numeric(t, op) {
  const p = prune(t);
  if (p.k === 'var') { unify(p, INT); return INT; }
  if (p.name !== 'int' && p.name !== 'real') {
    throw new TypeError_(`${show(p)} is not a number, and ${op === 'STAR' ? '*' : 'arithmetic'} needs one`);
  }
  return p;
}
const COMPARE = new Set(['LT', 'GT', 'LE', 'GE']);

export function infer(node, env, cons) {
  switch (node.type) {
    case 'Lit': return node.real ? REAL : INT;
    case 'CharLit': return CHAR;
    case 'StrLit': return STR;
    case 'Neg': {
      const t = infer(node.arg, env, cons);
      return t;      // int or real, whichever it was
    }

    // `()` is the one value of type unit. It had no case here at all and took
    // the fresh-variable fallback, so `:t ()` answered `'a`.
    case 'Unit': return UNIT;

    case 'Var': {
      const k = nameKey(node.name);
      if (Object.prototype.hasOwnProperty.call(env, k)) return instantiate(env[k]);
      if (k === 'true' || k === 'false') return BOOL;
      if (k === 'nil') return listOf(fresh());
      if (cons[node.name]) return instantiate(cons[node.name]);
      // A name nothing has bound. Standard ML makes it an error, and so does
      // the EVALUATOR here since v1.299 — but the checker went on inventing a
      // fresh variable for it, so `:t nosuchname` answered `'a` and told you a
      // name had a type when there was no such name. Silent, and it is what
      // made `:t map` look like a typing bug when `map` is simply not bound at
      // top level (`List.map` is).
      //
      // The reason for the old behaviour was a GAME reason: NostOS consoles
      // have verbs that reach into the world, and refusing them would make
      // inference a gate rather than a report. So this takes the same shape as
      // the evaluator's `setHostUnbound` — the language refuses, and a host
      // that has its own names says so.
      if (HOST_KNOWS_NAME && HOST_KNOWS_NAME(node.name)) return fresh();
      // A QUALIFIED name keeps the old fallback, and the line between the two
      // is which side the gap is on. `map` is a plain name: if nothing bound
      // it, the program is wrong. `Small.keep` is a member of a structure, and
      // this module cannot always work out what a structure holds — the result
      // of a functor application is the standing case, where the evaluator
      // binds the members and the checker never learns them. Refusing there
      // would make the checker gate on ITS OWN gaps and reject a correct
      // program, which is how `examples/07-modules.ml` broke the first time
      // this refusal went in without the distinction.
      if (node.name.includes('.')) return fresh();
      throw new TypeError_(`unbound variable: ${node.name}`);
    }

    case 'Lam': {
      const p = fresh();
      if (node.ann) unify(p, fromAnnotation(node.ann, new Map()));
      const env2 = { ...env, [nameKey(node.param)]: mono(p) };
      return fnOf(p, infer(node.body, env2, cons));
    }

    case 'App': {
      // A PROJECTION applied to something written out. `#1 (1, 2)` is int, and
      // `#name {name = "x", n = 1}` is string, because both the label and the
      // shape are right there. The general case needs row polymorphism and
      // still answers a fresh variable (see 'Select' below); this is the case
      // anyone actually writes at a prompt, and answering `'a` for it was
      // needlessly coy.
      //
      // v1.305: project from the argument's INFERRED type rather than from how
      // it was written. The syntactic version only worked when the record or
      // tuple was spelled out at the call, so `val r = {name = "a", age = 3}`
      // then `#age r` answered `'a` — the checker knew r was a record and
      // which field was which, and declined to look. Inferring first covers
      // both, and the written-out cases fall out of it.
      if (node.fn && node.fn.type === 'Select' && node.arg) {
        const at = prune(infer(node.arg, env, cons));
        if (at.k === 'con' && at.name === 'record' && at.labels) {
          const i = at.labels.indexOf(node.fn.label);
          if (i >= 0) return at.args[i];
        }
        if (at.k === 'con' && at.name === '*' && /^[0-9]+$/.test(node.fn.label)) {
          const i = parseInt(node.fn.label, 10) - 1;
          if (i >= 0 && i < at.args.length) return at.args[i];
        }
        // Anything else needs row polymorphism and stays honestly unknown.
        return fresh();
      }
      // A multi-argument constructor may be applied to a TUPLE, `N (a, b, c)`,
      // which is how Standard ML writes it, as well as curried, `N a b c`,
      // which is this build's own spelling. The evaluator learned both in
      // v1.282 and the checker did not, so `fun ins (L, x) = N (L, x, L)` was
      // refused as ill-typed — and strict is the DEFAULT, so the default mode
      // rejected a correct program that advisory mode ran perfectly.
      if (node.fn && node.fn.type === 'Var' && node.arg && node.arg.type === 'Tuple'
          && cons[node.fn.name]) {
        const arity = CURRENT_CONARITY[node.fn.name];
        if (arity > 1 && arity === node.arg.items.length) {
          let t = instantiate(cons[node.fn.name]);
          for (const item of node.arg.items) {
            const step = fresh();
            unify(t, fnOf(infer(item, env, cons), step));
            t = step;
          }
          return t;
        }
      }
      const f = infer(node.fn, env, cons);
      const arg = infer(node.arg, env, cons);
      const res = fresh();
      unify(f, fnOf(arg, res));
      return res;
    }

    case 'If': {
      unify(infer(node.cond, env, cons), BOOL);
      const a = infer(node.then, env, cons);
      const b = infer(node.else, env, cons);
      unify(a, b);
      return a;
    }

    case 'Bin': {
      const l = infer(node.left, env, cons);
      const r = infer(node.right, env, cons);
      if (node.op === 'CARET') { unify(l, STR); unify(r, STR); return STR; }
      // + - * take two of the SAME numeric kind and give that kind back, which
      // is how the two are kept apart without a coercion anywhere. div and mod
      // are whole-number only; / is real only.
      if (node.op === 'DIV' || node.op === 'MOD') { unify(l, INT); unify(r, INT); return INT; }
      if (node.op === 'SLASH') { unify(l, REAL); unify(r, REAL); return REAL; }
      if (NUMERIC.has(node.op)) { unify(l, r); return numeric(l, node.op); }
      // COMPARISON is overloaded in Standard ML across int, real, char and
      // string, and the evaluator was taught the last two in v1.296. This line
      // still called `numeric`, so the checker forced both sides to a number
      // and `quicksort` inferred `int list -> int list` from its first use,
      // which meant the same function could not then sort words. The two sides
      // must agree; what they agree ON is not the checker's business here.
      if (COMPARE.has(node.op)) { unify(l, r); return BOOL; }
      unify(l, r);                 // == and <> compare any two of one type
      return BOOL;
    }

    case 'Bool': {
      unify(infer(node.left, env, cons), BOOL);
      unify(infer(node.right, env, cons), BOOL);
      return BOOL;
    }

    case 'Cons': {
      const h = infer(node.head, env, cons);
      const t = infer(node.tail, env, cons);
      unify(t, listOf(h));
      return t;
    }

    case 'Append': {
      const a = infer(node.left, env, cons);
      const b = infer(node.right, env, cons);
      const e = fresh();
      unify(a, listOf(e));
      unify(b, listOf(e));
      return a;
    }

    case 'ListLit': {
      const e = fresh();
      for (const it of node.items) unify(infer(it, env, cons), e);
      return listOf(e);
    }

    case 'Tuple': return tupleOf(node.items.map((i) => infer(i, env, cons)));
    // !r : 'a  where r : 'a ref
    case 'Deref': {
      const inner = fresh();
      unify(infer(node.arg, env, cons), refOf(inner));
      return inner;
    }
    // r := v : unit  where r : 'a ref and v : 'a. The result is unit, which is
    // what makes `r := 1 ; !r` a sequence rather than a mistake.
    case 'Assign': {
      const inner = fresh();
      unify(infer(node.target, env, cons), refOf(inner));
      unify(infer(node.value, env, cons), inner);
      return UNIT;
    }

    case 'Record':
      return recordOf(node.fields.map((f) => f.label),
        node.fields.map((f) => infer(f.value, env, cons)));

    case 'Select': return fresh();     // needs row polymorphism; honestly unknown

    case 'While': {
      // `while c do e` is `bool`, then `unit`, and answers `unit`. There was no
      // case for it at all, so it took the fresh-variable default and reported
      // `'a` — which reads as *this could be anything* for a form that is
      // always exactly one thing.
      unify(infer(node.cond, env, cons), BOOL);
      infer(node.body, env, cons);
      return UNIT;
    }

    case 'Seq': {
      infer(node.left, env, cons);
      return infer(node.right, env, cons);
    }

    case 'Case': {
      const subject = infer(node.subject, env, cons);
      const result = fresh();
      for (const arm of node.arms) {
        const binds = {};
        unify(inferPattern(arm.pat, binds, cons), subject);
        const env2 = { ...env };
        for (const k of Object.keys(binds)) env2[k] = mono(binds[k]);
        unify(infer(arm.body, env2, cons), result);
      }
      // AFTER the arms, not before: until a pattern has been unified with it the
      // subject is still an unbound variable, and there is nothing to be
      // exhaustive over.
      checkExhaustive(subject, node.arms, cons);
      return result;
    }

    // A binding is recursive: the name is in scope inside its own value, which
    // is what lets a function call itself. Generalising AFTER the value is
    // inferred is what makes it polymorphic outside.
    // Several bindings sharing one scope, so each may refer to the others.
    // Every name goes in as a fresh monotype first (that is what lets the
    // mutual reference typecheck at all), the values are inferred against that
    // environment, and only then are they generalised for the body.
    case 'LetRec': {
      const inner = { ...env };
      const vars = [];
      for (const b of node.binds) {
        const v = fresh();
        vars.push(v);
        inner[nameKey(b.name)] = mono(v);
      }
      node.binds.forEach((b, i) => unify(vars[i], infer(b.value, inner, cons)));
      const env2 = { ...env };
      node.binds.forEach((b, i) => { env2[nameKey(b.name)] = generalise(env, vars[i]); });
      return infer(node.body, env2, cons);
    }

    case 'Let':
    case 'TopLet': {
      const v = fresh();
      const inner = { ...env, [nameKey(node.name)]: mono(v) };
      const t = infer(node.value, inner, cons);
      unify(v, t);
      const env2 = { ...env, [nameKey(node.name)]: generalise(env, t) };
      return node.type === 'TopLet' ? t : infer(node.body, env2, cons);
    }

    case 'LetPat':
    case 'TopLetPat': {
      const t = infer(node.value, env, cons);
      const binds = {};
      unify(inferPattern(node.pat, binds, cons), t);
      const env2 = { ...env };
      for (const k of Object.keys(binds)) env2[k] = generalise(env, binds[k]);
      return node.type === 'TopLetPat' ? t : infer(node.body, env2, cons);
    }

    // An annotation is a claim. Unifying it with what was inferred is what
    // turns it from a decoration into something the machine holds you to, and
    // is the only reason it was worth parsing rather than stepping over.
    case 'Annot': {
      const t = infer(node.expr, env, cons);
      const want = fromAnnotation(node.ann, new Map());
      // `fun sq (n:int):int = …` annotates the RESULT, not the function. Peel
      // one arrow per parameter before unifying, or the claim is compared
      // against `num -> num` and reported as a clash that is not one.
      let target = t;
      for (let i = 0; i < (node.params || 0); i++) {
        const a = fresh();
        const b = fresh();
        try { unify(target, fnOf(a, b)); } catch { break; }
        target = b;
      }
      unify(target, want);
      return t;
    }

    case 'Datatype': return UNIT;

    // A STRUCTURE. Until v1.293 this fell through to `fresh()` below, so
    // `structure List = struct … end` was never walked and no member ever got a
    // type. `List.map` then looked up `list.map`, missed, and took the same
    // fallback, which is why every qualified name reported `'a` — not just the
    // one you noticed, but the whole family, and any binding made from one.
    //
    // The members are inferred in a child environment, in order, so a member
    // may use the ones declared before it (String.size calls List.nth). What
    // each turned out to be is left on the node for `remember` to publish,
    // because `remember` is where the session learns anything and inference is
    // not supposed to write to it.
    // `structure T = F (A)`. Infer the FUNCTOR'S BODY again, with the
    // argument's members bound under the parameter's name, and publish what
    // comes out as T's members. Without this there was no case at all and the
    // application took the fresh-variable default, so `T.m` reported `'a`
    // however plain its type — and since a qualified name keeps the unbound
    // fallback (v1.304), nothing said so.
    //
    // Re-inferring rather than copying the functor's own member types is what
    // makes it right: `val m = X.z + 1` is `int` because THIS argument's `z`
    // is an int, and a different argument could make it something else. That
    // is what a functor is for.
    // `structure Q = Queue`. Nothing to infer: the members already have types
    // under the old name, and `remember` copies them to the new one.
    case 'StructAlias': return UNIT;

    case 'StructApply': {
      const f = CURRENT_FUNCTORS[node.functor];
      if (!f) return UNIT;
      const inner = { ...env };
      const bind = (bare, sch) => {
        inner[bare] = sch;
        inner[`${nameKey(f.param)}.${bare}`] = sch;
      };
      if (node.argDecls) {
        // An anonymous structure: type its declarations here and hand those on.
        for (const d of node.argDecls) {
          if (!d || d.type !== 'TopLet') { try { infer(d, inner, cons); } catch { /* not this module's */ } continue; }
          try {
            const v = fresh();
            const rec = { ...inner, [nameKey(d.name)]: mono(v) };
            const t = infer(d.value, rec, cons);
            unify(v, t);
            bind(nameKey(d.name), isSyntacticValue(d.value) ? generalise(env, t) : mono(t));
          } catch { /* one member that will not type does not stop the rest */ }
        }
      } else {
        const prefix = `${nameKey(node.arg || '')}.`;
        for (const k of Object.keys(env)) {
          if (k.startsWith(prefix)) bind(k.slice(prefix.length), env[k]);
        }
      }
      const members = {};
      for (const d of f.decls || []) {
        if (!d || d.type !== 'TopLet') { try { infer(d, inner, cons); } catch { /* as above */ } continue; }
        try {
          // PRE-BIND ONLY A FUNCTION. `fun` is implicitly recursive in Standard
          // ML and `val` is not, and both arrive here as TopLet — the
          // difference is that `fun` (and `val rec`) parse to a Lam. Binding
          // the name for a plain `val` made an ALIAS self-referential:
          // `val sqrt = sqrt` inside `structure Math` read the right-hand
          // `sqrt` as the one being declared rather than the primitive, so
          // `Math.sqrt 4.0` reported `'a`.
          const isFn = d.value && d.value.type === 'Lam';
          const v = fresh();
          const rec = isFn ? { ...inner, [nameKey(d.name)]: mono(v) } : inner;
          const t = infer(d.value, rec, cons);
          if (isFn) unify(v, t);
          const sch = isSyntacticValue(d.value) ? generalise(env, t) : mono(t);
          inner[nameKey(d.name)] = sch;
          members[nameKey(d.name)] = sch;
        } catch { /* as above */ }
      }
      node.__members = members;
      return UNIT;
    }

    // A RUN OF DECLARATIONS. `val u = 1 and v = 2`, and since v1.307 also
    // `val p = 1; val q = 2`. There was no case for it AT ALL, so it took the
    // fresh-variable default and `remember` was never told what either name is
    // — the evaluator bound them and the checker did not, which under strict
    // meant `val u = 1 and v = 2` declared two names and then refused both the
    // moment you used one. Pre-dates the `;` work; routing `;` through the same
    // node is what made it visible.
    //
    // Each item's type is left on the item, the way StructDecl leaves its
    // members, because `remember` is where the session learns anything.
    case 'Decls': {
      let inner = { ...env };
      for (const d of node.items || []) {
        if (!d) continue;
        {
          // NO try/catch here, deliberately. StructDecl has one — a structure
          // is not all-or-nothing, and one member the checker cannot type does
          // not spoil the rest — and copying it here was wrong: a clash in one
          // declaration of a top-level run must refuse the LINE, exactly as it
          // would if the declaration stood alone. With the catch,
          // `type ct = int; val w : ct = "s"` ran.
          const t = infer(d, inner, cons);
          d.__t = t;
          // SEQUENTIAL runs (`;`, and an abstype with-block) let each item see
          // what the ones before it declared. An `and`-chain is simultaneous,
          // so it does not.
          if (node.sequential) {
            if (d.type === 'TopLet') {
              inner = { ...inner, [nameKey(d.name)]: generalise(env, t) };
            } else if (d.type === 'Datatype' || d.type === 'TypeAbbrev' || d.type === 'StructDecl') {
              // A DECLARATION THAT INTRODUCES NAMES rather than a value.
              // `datatype c = R; val z = R` has to know what R is by the time
              // it reaches the second item, or z reports the fallback. Run the
              // same `remember` the session would, into a scratch one, and take
              // what it worked out.
              const scratch = {};
              try { remember(d, scratch, t); } catch { /* not this module's */ }
              for (const k of Object.keys(scratch.__contypes || {})) cons[k] = scratch.__contypes[k];
              for (const k of Object.keys(scratch.__datacons || {})) CURRENT_DATACONS[k] = scratch.__datacons[k];
              for (const k of Object.keys(scratch.__conarity || {})) CURRENT_CONARITY[k] = scratch.__conarity[k];
              for (const k of Object.keys(scratch.__abbrevs || {})) CURRENT_ABBREVS[k] = scratch.__abbrevs[k];
              for (const k of Object.keys(scratch.__types || {})) inner[k] = scratch.__types[k];
            }
          }
        }
      }
      return UNIT;
    }

    case 'StructDecl': case 'FunctorDecl': {
      const inner = { ...env };
      const members = {};
      for (const d of node.decls || []) {
        if (!d || d.type !== 'TopLet') { try { infer(d, inner, cons); } catch { /* a member this module cannot type is not an error in the structure */ } continue; }
        try {
          // BIND THE MEMBER'S OWN NAME FIRST, exactly as 'TopLet' does above.
          // Every function in the Basis is recursive — `fun map f nil = nil |
          // map f (h :: t) = f h :: map f t` names itself in its own body — and
          // without this the self-reference is a name nothing has bound. It went
          // unnoticed while an unbound name silently became a fresh variable:
          // the member typed, wrongly but quietly. The moment the checker began
          // refusing unbound names instead, EVERY recursive member of the Basis
          // failed to type and was dropped by the catch below, so `List.map`
          // vanished from the checker's registry and strict mode refused the
          // whole standard library.
          // PRE-BIND ONLY A FUNCTION. `fun` is implicitly recursive in Standard
          // ML and `val` is not, and both arrive here as TopLet — the
          // difference is that `fun` (and `val rec`) parse to a Lam. Binding
          // the name for a plain `val` made an ALIAS self-referential:
          // `val sqrt = sqrt` inside `structure Math` read the right-hand
          // `sqrt` as the one being declared rather than the primitive, so
          // `Math.sqrt 4.0` reported `'a`.
          const isFn = d.value && d.value.type === 'Lam';
          const v = fresh();
          const rec = isFn ? { ...inner, [nameKey(d.name)]: mono(v) } : inner;
          const t = infer(d.value, rec, cons);
          if (isFn) unify(v, t);
          const sch = isSyntacticValue(d.value) ? generalise(env, t) : mono(t);
          inner[nameKey(d.name)] = sch;
          members[nameKey(d.name)] = sch;
        } catch {
          // One member that will not type does not stop the rest: the console
          // reports rather than gates, and a structure is not all-or-nothing.
        }
      }
      node.__members = members;
      return UNIT;
    }

    default: return fresh();
  }
}

// Turn a written type into one of ours. A name this build has no opinion about
// (a datatype you declared, a type abbreviation) becomes a variable: unknown
// rather than wrong.
const ANNOT = { int: INT, real: REAL, num: INT, word: INT, string: STR, str: STR, char: CHAR, bool: BOOL, unit: UNIT };

export function fromAnnotation(a, vars) {
  if (!a) return fresh();
  if (a.t === 'name') {
    if (/^'/.test(a.name)) {
      if (!vars.has(a.name)) vars.set(a.name, fresh());
      return vars.get(a.name);
    }
    // A DATATYPE this session has declared is the type it says it is, so
    // `val x : colour = 5` is a clash. Anything else stays a variable: a type
    // ABBREVIATION (`type count = int`) is not tracked, and making it rigid
    // would refuse `val n : count = 5` for saying `count` where the checker
    // worked out `int`.
    const nm = nameKey(a.name);
    if (ANNOT[nm]) return ANNOT[nm];
    // An abbreviation of NO parameters: `type count = int`, so `count` IS int.
    const ab0 = CURRENT_ABBREVS && CURRENT_ABBREVS[nm];
    if (ab0 && !ab0.params.length) return fromAnnotation(ab0.rhs, vars);
    if (CURRENT_DATACONS && CURRENT_DATACONS[nm]) return con(nm);
    return fresh();
  }
  if (a.t === 'app') {
    const nm = nameKey(a.name);
    // AN ABBREVIATION APPLIED TO ARGUMENTS: `int syn`, where
    // `type 'a syn = 'a list`. Expand it by binding the parameters to the
    // arguments and reading the right-hand side in that scope, so `int syn`
    // and `int list` are the same type and a clash between them is not one.
    const ab = CURRENT_ABBREVS && CURRENT_ABBREVS[nm];
    if (ab && ab.params.length) {
      const given = a.args ? a.args : [a.arg];
      if (given.length === ab.params.length) {
        const inner2 = new Map(vars);
        ab.params.forEach((v, i) => inner2.set(v, fromAnnotation(given[i], vars)));
        return fromAnnotation(ab.rhs, inner2);
      }
      // The wrong number of arguments is somebody's mistake, but this module
      // reports types rather than arities, so it declines to guess.
      return fresh();
    }
    if (a.args) {
      const args = a.args.map((x) => fromAnnotation(x, vars));
      return (CURRENT_DATACONS && CURRENT_DATACONS[nm]) ? con(nm, args) : fresh();
    }
    const inner = fromAnnotation(a.arg, vars);
    if (nm === 'list') return listOf(inner);
    // `int box`, once `datatype 'a box` has been declared. Same line as above:
    // known datatype, real type; anything else (an abbreviation such as
    // `type 'a syn = 'a list`, or a type from a structure this module did not
    // walk) keeps the variable, because a wrong rigid type refuses correct
    // programs and a variable only under-reports.
    if (CURRENT_DATACONS && CURRENT_DATACONS[nm]) return con(nm, [inner]);
    return fresh();
  }
  if (a.t === 'tuple') return tupleOf(a.parts.map((x) => fromAnnotation(x, vars)));
  if (a.t === 'record') return recordOf(a.labels, a.parts.map((x) => fromAnnotation(x, vars)));
  if (a.t === 'fn') return fnOf(fromAnnotation(a.from, vars), fromAnnotation(a.to, vars));
  return fresh();
}

// ---- the entry point -------------------------------------------------------
//
// Infers the type of one parsed line against a session. Returns the type as a
// string, or the clash as one. Never throws: a report that can crash the
// console it is reporting to is not a report.
// Warnings raised while inferring the current line. A module-level list because
// inference is a recursive walk and threading a collector through every case
// would cost more than it is worth for one advisory message.
// What the HOST claims to know. The mirror of `setHostUnbound` in eval.js: the
// language refuses a name nothing has bound, and NostOS answers for the verbs
// its consoles reach the world through, which were never declared anywhere.
// Nothing sets this in BML, so BML refuses, which is what Standard ML does.
let HOST_KNOWS_NAME = null;
export function setHostKnowsName(fn) { HOST_KNOWS_NAME = fn; }

let WARNINGS = [];

export function typeOf(ast, session = {}) {
  WARNINGS = [];
  const env = { ...baseEnv() };
  const cons = {};
  const reg = session.__types || {};
  for (const k of Object.keys(reg)) env[k] = reg[k];
  for (const k of Object.keys(session.__contypes || {})) cons[k] = session.__contypes[k];
  CURRENT_DATACONS = session.__datacons || {};
  CURRENT_FUNCTORS = session.__functors || {};
  CURRENT_ABBREVS = session.__abbrevs || {};
  CURRENT_CONARITY = session.__conarity || {};
  try {
    const t = infer(ast, env, cons);
    // A RUN OF DECLARATIONS reports one type PER DECLARATION, because that is
    // what it is: `val p = 1; val q = 2` is two bindings and Standard ML gives
    // each its own line. Reporting the run's own type instead printed
    // `val q = 2 : unit`, which says the wrong thing about q.
    if (ast.type === 'Decls' && (ast.items || []).length > 1) {
      const each = ast.items.map((d) => (d && d.__t !== undefined ? show(d.__t) : 'unit'));
      return { ok: true, type: each.join('\n'), t, warnings: WARNINGS.slice() };
    }
    return { ok: true, type: show(t), t, warnings: WARNINGS.slice() };
  } catch (e) {
    if (e instanceof TypeError_) return { ok: false, error: e.message };
    return { ok: false, error: null };     // a gap in this module, not in the code
  }
}

// Record what a top-level binding turned out to be, so the next line can use
// it. Declaring a datatype registers its constructors as functions into it.

// A constructor argument's declared type, from the words the parser kept.
// Deliberately small: the base types, a list of one of them, and the datatype
// being declared (so `Node of tree * int * tree` knows what a tree is). Anything
// else is a fresh variable, which is no worse than before this existed.
const BASE_TYPES = { int: () => INT, real: () => REAL, string: () => STR, str: () => STR, bool: () => BOOL, char: () => CHAR, unit: () => UNIT };
function typeOfWords(ws, selfType, selfName, tyvars) {
  if (!ws || !ws.length) return fresh();
  const last = ws[ws.length - 1];
  const head = ws[0];
  const baseOf = (w) => {
    if (BASE_TYPES[w]) return BASE_TYPES[w]();
    if (selfName && w === selfName) return selfType;
    // A TYPE PARAMETER of the declaration being read. It must resolve to the
    // variable the head already made for it, not to a fresh one: `Box of 'a`
    // has to be `'a -> 'a box` with the SAME variable at both ends, or `Box 1`
    // reports `'b box` and the parameter tells you nothing (D-56).
    if (tyvars && Object.prototype.hasOwnProperty.call(tyvars, w)) return tyvars[w];
    return null;
  };
  if (ws.length === 1) return baseOf(head) || fresh();
  if (last === 'list') { const b = baseOf(head); return b ? listOf(b) : fresh(); }
  // `'a tree` — a parameterised type applied to an argument, which is how a
  // recursive datatype names itself: `Node of 'a tree * 'a * 'a tree`. The
  // words arrive head-first, so the last is the constructor and the rest are
  // its arguments.
  if (selfName && last === selfName && ws.length > 1) {
    const args = ws.slice(0, -1).map((w) => baseOf(w) || fresh());
    return con(selfName, args);
  }
  return baseOf(last) || baseOf(head) || fresh();
}

export function remember(ast, session, t) {
  if (!session.__types) session.__types = {};
  if (!session.__contypes) session.__contypes = {};
  if (ast.type === 'TopLet') {
    // `fun f x = ...` is a lambda and generalises; `val r = ref nil` is an
    // application and does not.
    session.__types[nameKey(ast.name)] = isSyntacticValue(ast.value)
      ? generalise({}, t)
      : mono(t);
  } else if (ast.type === 'StructAlias') {
    // Every member type under the old name appears under the new one, so
    // `Q.insert` types as `Queue.insert` does rather than falling to the
    // qualified-name fallback.
    if (!session.__types) session.__types = {};
    const from = `${nameKey(ast.from)}.`;
    const to = `${nameKey(ast.name)}.`;
    for (const k of Object.keys(session.__types)) {
      if (k.startsWith(from)) session.__types[to + k.slice(from.length)] = session.__types[k];
    }
  } else if ((ast.type === 'StructDecl' || ast.type === 'StructApply') && ast.__members) {
    // Published as flat qualified keys, `list.map`, because that is exactly how
    // the evaluator publishes them and how the parser hands the name over:
    // `List.map` is ONE Var node whose name contains a dot, not a selection.
    for (const k of Object.keys(ast.__members)) {
      session.__types[`${nameKey(ast.name)}.${k}`] = ast.__members[k];
    }
  } else if (ast.type === 'Decls') {
    // Each item on its own, with the type `infer` left on it above.
    for (const d of ast.items || []) {
      if (d && d.__t !== undefined) remember(d, session, d.__t);
    }
  } else if (ast.type === 'TypeAbbrev' && ast.rhs) {
    if (!session.__abbrevs) session.__abbrevs = {};
    session.__abbrevs[nameKey(ast.name)] = { params: ast.params || [], rhs: ast.rhs };
  } else if (ast.type === 'Datatype') {
    // ONE VARIABLE PER TYPE PARAMETER, made here and shared by every mention of
    // that parameter in every constructor. `datatype 'a box = Box of 'a` is
    // `Box : 'a -> 'a box`, one variable; the whole point of the parameter is
    // that the two ends are the same. `generalise` below then quantifies it,
    // so each USE of Box gets its own instance.
    const tyvars = {};
    for (const v of ast.params || []) tyvars[v] = fresh();
    const self = con(ast.name, (ast.params || []).map((v) => tyvars[v]));
    if (!session.__datacons) session.__datacons = {};
    // Which constructors make up this type, in declared order. The exhaustiveness
    // check needs the whole set, and nothing else records it.
    session.__datacons[ast.name] = ast.cons.map((c) => c.name);
    for (const c of ast.cons) {
      let ty = self;
      // Build the arrow chain from the RIGHT, so the declared types line up
      // with the arguments in order. Each part's words come from the parser;
      // a base type is used as written, `X list` becomes a list of X, and
      // anything this module has no opinion about stays a fresh variable,
      // which is what every argument used to be.
      const words = c.argWords || [];
      for (let i = c.arity - 1; i >= 0; i--) ty = fnOf(typeOfWords(words[i], self, ast.name, tyvars), ty);
      session.__contypes[c.name] = generalise({}, ty);
      if (!session.__conarity) session.__conarity = {};
      session.__conarity[c.name] = c.arity;
    }
  }
}
