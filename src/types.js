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

export function fresh() { return { k: 'var', id: NEXT++, ref: null }; }
export function con(name, args = []) { return { k: 'con', name, args }; }

export const INT = con('int');
export const REAL = con('real');
export const CHAR = con('char');
// Kept as a name for the places that only care that it is a number.
export const NUM = INT;
export const STR = con('str');
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
  return `${p.args.map((a) => showArg(a, names)).join(' ')} ${p.name}`;
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
      binds[pat.name.toLowerCase()] = t;
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
        for (const arg of pat.args) {
          const at = inferPattern(arg, binds, cons);
          const res = fresh();
          unify(t, fnOf(at, res));
          t = res;
        }
        return t;
      }
      const v = fresh();
      binds[pat.name.toLowerCase()] = v;
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

    case 'Var': {
      const k = node.name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(env, k)) return instantiate(env[k]);
      if (k === 'true' || k === 'false') return BOOL;
      if (k === 'nil') return listOf(fresh());
      if (cons[node.name]) return instantiate(cons[node.name]);
      // A name this module has never seen. Not an error: the console has verbs
      // that reach into the world, and refusing them would make inference a
      // gate rather than a report.
      return fresh();
    }

    case 'Lam': {
      const p = fresh();
      if (node.ann) unify(p, fromAnnotation(node.ann, new Map()));
      const env2 = { ...env, [node.param.toLowerCase()]: mono(p) };
      return fnOf(p, infer(node.body, env2, cons));
    }

    case 'App': {
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
      if (COMPARE.has(node.op)) { unify(l, r); numeric(l, node.op); return BOOL; }
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
    case 'Let':
    case 'TopLet': {
      const v = fresh();
      const inner = { ...env, [node.name.toLowerCase()]: mono(v) };
      const t = infer(node.value, inner, cons);
      unify(v, t);
      const env2 = { ...env, [node.name.toLowerCase()]: generalise(env, t) };
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
    return ANNOT[a.name.toLowerCase()] || fresh();
  }
  if (a.t === 'app') {
    const inner = fromAnnotation(a.arg, vars);
    return a.name.toLowerCase() === 'list' ? listOf(inner) : fresh();
  }
  if (a.t === 'tuple') return tupleOf(a.parts.map((x) => fromAnnotation(x, vars)));
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
let WARNINGS = [];

export function typeOf(ast, session = {}) {
  WARNINGS = [];
  const env = { ...baseEnv() };
  const cons = {};
  const reg = session.__types || {};
  for (const k of Object.keys(reg)) env[k] = reg[k];
  for (const k of Object.keys(session.__contypes || {})) cons[k] = session.__contypes[k];
  CURRENT_DATACONS = session.__datacons || {};
  try {
    const t = infer(ast, env, cons);
    return { ok: true, type: show(t), t, warnings: WARNINGS.slice() };
  } catch (e) {
    if (e instanceof TypeError_) return { ok: false, error: e.message };
    return { ok: false, error: null };     // a gap in this module, not in the code
  }
}

// Record what a top-level binding turned out to be, so the next line can use
// it. Declaring a datatype registers its constructors as functions into it.
export function remember(ast, session, t) {
  if (!session.__types) session.__types = {};
  if (!session.__contypes) session.__contypes = {};
  if (ast.type === 'TopLet') {
    // `fun f x = ...` is a lambda and generalises; `val r = ref nil` is an
    // application and does not.
    session.__types[ast.name.toLowerCase()] = isSyntacticValue(ast.value)
      ? generalise({}, t)
      : mono(t);
  } else if (ast.type === 'Datatype') {
    const self = con(ast.name);
    if (!session.__datacons) session.__datacons = {};
    // Which constructors make up this type, in declared order. The exhaustiveness
    // check needs the whole set, and nothing else records it.
    session.__datacons[ast.name] = ast.cons.map((c) => c.name);
    for (const c of ast.cons) {
      let ty = self;
      for (let i = 0; i < c.arity; i++) ty = fnOf(fresh(), ty);
      session.__contypes[c.name] = generalise({}, ty);
    }
  }
}
