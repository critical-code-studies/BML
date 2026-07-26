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

export const NUM = con('num');
export const STR = con('str');
export const BOOL = con('bool');
export const UNIT = con('unit');
export const listOf = (t) => con('list', [t]);
export const fnOf = (a, b) => con('->', [a, b]);
export const tupleOf = (ts) => con('*', ts);

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
    abs: mono(fnOf(NUM, NUM)),
    sqrt: mono(fnOf(NUM, NUM)),
    min: mono(fnOf(NUM, fnOf(NUM, NUM))),
    max: mono(fnOf(NUM, fnOf(NUM, NUM))),
    size: scheme([b.id], fnOf(b, NUM)),
    echo: scheme([b.id], fnOf(b, UNIT)),
  };
}

// ---- inference -------------------------------------------------------------

function inferPattern(pat, binds, cons) {
  switch (pat.p) {
    case 'wild': return fresh();
    case 'num': return NUM;
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
const COMPARE = new Set(['LT', 'GT', 'LE', 'GE']);

export function infer(node, env, cons) {
  switch (node.type) {
    case 'Lit': return NUM;
    case 'StrLit': return STR;

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
      if (NUMERIC.has(node.op)) { unify(l, NUM); unify(r, NUM); return NUM; }
      if (COMPARE.has(node.op)) { unify(l, NUM); unify(r, NUM); return BOOL; }
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
const ANNOT = { int: NUM, real: NUM, num: NUM, word: NUM, string: STR, str: STR, char: STR, bool: BOOL, unit: UNIT };

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
export function typeOf(ast, session = {}) {
  const env = { ...baseEnv() };
  const cons = {};
  const reg = session.__types || {};
  for (const k of Object.keys(reg)) env[k] = reg[k];
  for (const k of Object.keys(session.__contypes || {})) cons[k] = session.__contypes[k];
  try {
    const t = infer(ast, env, cons);
    return { ok: true, type: show(t), t };
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
    session.__types[ast.name.toLowerCase()] = generalise({}, t);
  } else if (ast.type === 'Datatype') {
    const self = con(ast.name);
    for (const c of ast.cons) {
      let ty = self;
      for (let i = 0; i < c.arity; i++) ty = fnOf(fresh(), ty);
      session.__contypes[c.name] = generalise({}, ty);
    }
  }
}
