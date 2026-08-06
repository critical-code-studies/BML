// THE EVALUATOR. An abstract syntax tree to a value.
//
// Part of src/lang/, the language proper. Moved out of src/game/ai_ml.js at
// v1.287 (M2). See docs/aiml-standalone-plan.md.
//
// WHY THE STATE IS MODULE-LEVEL, and why it moved here rather than being
// re-plumbed. FUEL and STEPS are module-level for the same reason the print
// buffer is: a closure captures the ctx of the line that DEFINED it, so hanging
// a counter off ctx meant a function called on a later line counted against the
// wrong budget, and hanging the buffer off ctx silently swallowed the output of
// any function called on a later line. Both were real bugs. Threading them as
// parameters would mean touching every one of evalNode's recursive calls, which
// is a larger change than this stage is allowed to make.

import { RonmlError, RonmlFuelError, RonmlRaise } from './errors.js';
import { parse } from './parse.js';
import { defaultFixity } from './parse.js';

// FUEL (docs/robot-programs-plan.md §3). A program carried by a machine must not
// be able to hang the game: `let f x = f x` has to stop somewhere. Evaluation
// counts reductions and aborts past a budget. At a console the budget is huge
// (a human is waiting, and a wrong line should still finish); for a machine's
// own program it is small and strict, because a unit whose program overruns is
// not an error message — it is a FAULT in that machine, and it should read that
// way in play.
export const CONSOLE_FUEL = 200000;
let STEPS = 0;
let FUEL = CONSOLE_FUEL;

// Start a run. Every entry point calls this before evaluating, so the budget is
// per-line rather than per-session.
export function beginRun(fuel) {
  STEPS = 0;
  FUEL = fuel || CONSOLE_FUEL;
}

// The current run's print buffer. `echo` pushes into it as evaluation proceeds
// and every entry point installs a fresh one per line, so output arrives in
// order even from deep inside a recursion. Module-level for the same reason the
// fuel counters are: closures capture the ctx of the line that DEFINED them, so
// a per-ctx buffer silently swallowed the output of any function called on a
// LATER line. That was a real bug.
let OUT = null;
export function setOut(buf) { OUT = buf; }
export function pushOut(text) { if (OUT) OUT.push(text); }

// What the HOST wants said about a name the language does not know. The
// language has no verbs; NostOS does, and wants "that is a HERMES command, not
// an obelisk one" rather than "no such name". Installed once by the adapter.
let HOST_NAME_HINT = null;
export function setHostNameHint(fn) { HOST_NAME_HINT = fn; }

// What the HOST makes of a name nothing has bound. Standard ML makes it an
// error, and that is what happens when no host answers. NostOS answers with an
// atom, because its consoles pass bare words around as values: `hack OB_1A2B`
// names a tower, `copy factory_id.ml ob` names a file, and neither was ever
// declared. Returning nothing here means the language refuses.
let HOST_UNBOUND = null;
export function setHostUnbound(fn) { HOST_UNBOUND = fn; }

// ---- Evaluator -----------------------------------------------------------

export function applyValue(fnVal, argVal) {
  // A user lambda (closure): bind the parameter and evaluate the body in the
  // closure's captured environment (extended, so nothing leaks back out).
  if (fnVal && fnVal.tag === 'closure') {
    const env2 = Object.create(fnVal.env);
    env2[fnVal.param.toLowerCase()] = argVal;
    return evalNode(fnVal.body, env2, fnVal.ctx, fnVal.builtins);
  }
  // A datatype constructor that takes arguments behaves like a function until
  // it has them all, at which point it stops being one and becomes a value.
  // This is Harper's point about constructors: they build, and building is the
  // only thing they do.
  if (fnVal && fnVal.tag === 'select') {
    const l = fnVal.label;
    if (argVal && argVal.tag === 'record') {
      if (!Object.prototype.hasOwnProperty.call(argVal.fields, l)) throw new RonmlError(`no field ${l} in this record`);
      return argVal.fields[l];
    }
    if (argVal && argVal.tag === 'tuple') {
      const i = Number(l);
      if (!Number.isInteger(i) || i < 1 || i > argVal.items.length) throw new RonmlError(`a tuple of ${argVal.items.length} has no #${l}`);
      return argVal.items[i - 1];
    }
    throw new RonmlError(`${describeValue(argVal)} has no fields`);
  }
  if (fnVal && fnVal.tag === 'confn') {
    // `datatype p = P of int * int` declares ONE argument that is a pair, and
    // Standard ML writes it `P (1, 2)`. This build counts the `*` separators and
    // curries, so it writes `P 1 2` — which is what the in-game documentation
    // teaches and what the demos use. Accept both: a tuple of exactly the right
    // width completes the constructor in one go. Without this, `P (1, 2)` stayed
    // a half-applied constructor and printed as `<P>`, and every one of Harper's
    // `Node (l, e, r)` was a value that looked like a function.
    if (!fnVal.args.length && argVal && argVal.tag === 'tuple'
        && fnVal.arity > 1 && argVal.items.length === fnVal.arity) {
      return { tag: 'con', name: fnVal.name, args: argVal.items };
    }
    const args = [...fnVal.args, argVal];
    return args.length >= fnVal.arity
      ? { tag: 'con', name: fnVal.name, args }
      : { tag: 'confn', name: fnVal.name, arity: fnVal.arity, args };
  }
  if (!fnVal || fnVal.tag !== 'fn') {
    throw new RonmlError(`${describeValue(fnVal)} isn't something you can apply an argument to`);
  }
  const args = [...fnVal.args, argVal];
  if (args.length >= fnVal.builtin.arity) return fnVal.builtin.fn(args, fnVal.ctx);
  return { tag: 'fn', name: fnVal.name, builtin: fnVal.builtin, args, ctx: fnVal.ctx };
}

// Structural equality for `==` / `!=`: same tag and same payload. Numbers, strings,
// booleans compare by value; nodes/keys/files by their identifier; unit is unit.
function valuesEqual(a, b) {
  if (!a || !b || a.tag !== b.tag) return false;
  switch (a.tag) {
    case 'int': case 'real': case 'str': case 'bool': case 'char': return a.v === b.v;
    case 'tuple': return a.items.length === b.items.length && a.items.every((x, i) => valuesEqual(x, b.items[i]));
    case 'list': return a.items.length === b.items.length && a.items.every((x, i) => valuesEqual(x, b.items[i]));
    case 'con': return a.name === b.name && (a.args || []).length === (b.args || []).length
      && (a.args || []).every((x, i) => valuesEqual(x, b.args[i]));
    case 'node': return a.id === b.id;
    case 'key': return a.kind === b.kind && a.id === b.id;
    case 'file': return a.name === b.name;
    case 'unit': return true;
    // A record is equal when it has the same labels and equal values under
    // each. Field order is not part of a record, so compare by label.
    case 'record': {
      const ka = Object.keys(a.fields || {}), kb = Object.keys(b.fields || {});
      if (ka.length !== kb.length) return false;
      return ka.every((k) => k in (b.fields || {}) && valuesEqual(a.fields[k], b.fields[k]));
    }
    // A ref is equal to itself and to nothing else. Two cells holding the same
    // value are two cells: that is the whole point of having a cell, and it is
    // what Standard ML compares. `cell` is the identity.
    case 'ref': return a.cell === b.cell;
    default: return false;
  }
}

// Standard ML restricts `=` to EQUALITY TYPES, and a function is not one: `f = g`
// there is a type error, not a false. This build cannot say so in the type
// system, because the checker reports and does not refuse, so it says so at the
// point of comparison instead. Answering `false` when a function is compared
// with itself is the worse outcome, because nothing tells you it happened.
function equalityChecked(v, other) {
  for (const x of [v, other]) {
    if (x && (x.tag === 'fn' || x.tag === 'closure' || x.tag === 'builtin')) {
      throw new RonmlError('functions cannot be compared — there is no equality on functions');
    }
  }
}

// Evaluate an infix operator. Arithmetic and comparison want two numbers; `^`
// concatenates any two values as text; `==`/`!=` work on any pair.
function applyBinOp(op, l, r) {
  if (op === 'CARET') return { tag: 'str', v: formatValue(l) + formatValue(r) };
  if (op === 'EQEQ') { equalityChecked(l, r); return { tag: 'bool', v: valuesEqual(l, r) }; }
  if (op === 'NE') { equalityChecked(l, r); return { tag: 'bool', v: !valuesEqual(l, r) }; }

  // STRINGS AND CHARACTERS ARE ORDERED. In Standard ML the comparisons are
  // overloaded across int, real, char and string, and here they were numbers
  // only, so `"a" < "b"` was refused and nothing could be sorted but numbers.
  // Comparison is by code point, left to right, which is what SML's String
  // ordering is.
  const ORDERABLE = new Set(['LT', 'GT', 'LE', 'GE']);
  if (ORDERABLE.has(op) && l && r && l.tag === r.tag && (l.tag === 'str' || l.tag === 'char')) {
    const a0 = String(l.v), b0 = String(r.v);
    const cmp = a0 < b0 ? -1 : (a0 > b0 ? 1 : 0);
    const yes = op === 'LT' ? cmp < 0 : op === 'GT' ? cmp > 0 : op === 'LE' ? cmp <= 0 : cmp >= 0;
    return { tag: 'bool', v: yes };
  }

  // int and real are separate types now, as they are in ML, and the operators
  // divide along the same line: div and mod are whole-number, / is not. There
  // is no coercion between them; `real` and `floor` convert on request.
  const isInt = (x) => x && x.tag === 'int';
  const isReal = (x) => x && x.tag === 'real';
  const numeric = (x) => isInt(x) || isReal(x);
  const need = (x) => {
    if (!numeric(x)) throw new RonmlError(`${describeValue(x)} is not a number — arithmetic and comparison need numbers`);
    return x.v;
  };
  const a = need(l);
  const b = need(r);
  if (isInt(l) !== isInt(r)) {
    throw new RonmlError(`${describeValue(l)} and ${describeValue(r)} are not the same kind of number — use real n or floor x`);
  }
  const tag = isReal(l) ? 'real' : 'int';

  switch (op) {
    case 'PLUS': return { tag, v: a + b };
    case 'MINUS': return { tag, v: a - b };
    case 'STAR': return { tag, v: a * b };
    case 'SLASH':
      if (tag !== 'real') throw new RonmlError('/ divides reals. For whole numbers use div');
      if (b === 0) throw new RonmlError('division by zero');
      return { tag: 'real', v: a / b };
    case 'MOD':
      if (tag !== 'int') throw new RonmlError('mod is for whole numbers');
      if (b === 0) throw new RonmlError('mod by zero');
      return { tag: 'int', v: ((a % b) + b) % b };
    case 'DIV':
      if (tag !== 'int') throw new RonmlError('div is for whole numbers. For reals use /');
      if (b === 0) throw new RonmlRaise({ tag: 'con', name: 'Div', args: [], why: 'division by zero' });
      return { tag: 'int', v: Math.floor(a / b) };
    case 'LT': return { tag: 'bool', v: a < b };
    case 'GT': return { tag: 'bool', v: a > b };
    case 'LE': return { tag: 'bool', v: a <= b };
    case 'GE': return { tag: 'bool', v: a >= b };
    default: throw new RonmlError('malformed command');
  }
}

export function evalNode(node, env, ctx, builtins) {
  if (++STEPS > FUEL) throw new RonmlFuelError('step budget exceeded');
  switch (node.type) {
    case 'Lit': return { tag: node.real ? 'real' : 'int', v: node.value };
    case 'CharLit': return { tag: 'char', v: node.value };
    case 'Neg': {
      const x = evalNode(node.arg, env, ctx, builtins);
      if (!x || (x.tag !== 'int' && x.tag !== 'real')) throw new RonmlError(`${describeValue(x)} is not a number`);
      return { tag: x.tag, v: -x.v };
    }
    case 'StrLit': return { tag: 'str', v: node.value };
    case 'Lam': return { tag: 'closure', param: node.param, body: node.body, env, ctx, builtins };
    case 'Bin': return applyBinOp(node.op, evalNode(node.left, env, ctx, builtins), evalNode(node.right, env, ctx, builtins));
    // Cons builds a list by putting one value on the front of another list,
    // which is the definition rather than a convenience: Harper (1993, p.9)
    // gives the empty list and cons as the two cases a list can be.
    case 'Append': {
      const a = evalNode(node.left, env, ctx, builtins);
      const b = evalNode(node.right, env, ctx, builtins);
      if (!a || a.tag !== 'list') throw new RonmlError(`${describeValue(a)} is not a list — @ joins two lists`);
      if (!b || b.tag !== 'list') throw new RonmlError(`${describeValue(b)} is not a list — @ joins two lists`);
      return { tag: 'list', items: [...a.items, ...b.items] };
    }
    case 'Cons': {
      const head = evalNode(node.head, env, ctx, builtins);
      const tail = evalNode(node.tail, env, ctx, builtins);
      if (!tail || tail.tag !== 'list') throw new RonmlError(`${describeValue(tail)} is not a list — :: puts a value on the front of a list`);
      return { tag: 'list', items: [head, ...tail.items] };
    }
    case 'Seq': {
      evalNode(node.left, env, ctx, builtins);   // run the left for its effect, discard its value
      return evalNode(node.right, env, ctx, builtins);
    }
    case 'Bool': {
      const l = evalNode(node.left, env, ctx, builtins);
      if (!l || l.tag !== 'bool') throw new RonmlError(`${describeValue(l)} is not true or false`);
      if (node.op === 'and' && !l.v) return { tag: 'bool', v: false };   // short-circuit
      if (node.op === 'or' && l.v) return { tag: 'bool', v: true };
      const r = evalNode(node.right, env, ctx, builtins);
      if (!r || r.tag !== 'bool') throw new RonmlError(`${describeValue(r)} is not true or false`);
      return { tag: 'bool', v: r.v };
    }
    case 'If': {
      const c = evalNode(node.cond, env, ctx, builtins);
      if (!c || c.tag !== 'bool') throw new RonmlError('if needs a true/false test — try: if n == 0 then 1 else 0');
      return evalNode(c.v ? node.then : node.else, env, ctx, builtins);
    }
    case 'ListLit': return { tag: 'list', items: node.items.map((it) => evalNode(it, env, ctx, builtins)) };
    case 'Unit': return { tag: 'unit' };
    case 'Deref': {
      const r = evalNode(node.arg, env, ctx, builtins);
      if (!r || r.tag !== 'ref') throw new RonmlError(`${describeValue(r)} is not a ref`);
      return r.cell.v;
    }
    case 'Assign': {
      const r = evalNode(node.target, env, ctx, builtins);
      if (!r || r.tag !== 'ref') throw new RonmlError(`${describeValue(r)} is not a ref`);
      r.cell.v = evalNode(node.value, env, ctx, builtins);
      return { tag: 'unit' };
    }
    case 'Annot': return evalNode(node.expr, env, ctx, builtins);
    case 'Tuple': return { tag: 'tuple', items: node.items.map((it) => evalNode(it, env, ctx, builtins)) };
    case 'Record': {
      const fields = {};
      for (const f of node.fields) fields[f.label] = evalNode(f.value, env, ctx, builtins);
      return { tag: 'record', fields };
    }
    // #label and #1 are functions, not syntax, so they may be passed around:
    // `map #name people` works because #name is a value like any other.
    case 'Select': return { tag: 'select', label: node.label };

    // Declaring a datatype puts its constructors where names are looked up.
    // A nullary one IS a value; one that takes arguments is a function that
    // collects them and then is a value. Nothing is checked, because there is
    // nothing here to check with.
    case 'TypeAbbrev': return { tag: 'typename', name: node.name };

    // An exception is a constructor that can be raised. Declaring one puts it
    // where names are looked up, exactly like a datatype's constructors.
    case 'ExnDecl': {
      const store = (ctx && ctx.session) || {};
      const reg = (store.__cons = store.__cons || {});
      reg[node.name] = { name: node.name, arity: node.arity, of: 'exn' };
      (store.__exn = store.__exn || {})[node.name] = true;
      store[node.name.toLowerCase()] = node.arity === 0
        ? { tag: 'con', name: node.name, args: [] }
        : { tag: 'confn', name: node.name, arity: node.arity, args: [] };
      return { tag: 'exndecl', name: node.name };
    }

    case 'Raise': {
      const v = evalNode(node.arg, env, ctx, builtins);
      throw new RonmlRaise(v);
    }

    case 'Handle': {
      try {
        return evalNode(node.body, env, ctx, builtins);
      } catch (e) {
        if (!(e instanceof RonmlRaise)) throw e;
        for (const arm of node.arms) {
          const binds = matchPattern(arm.pat, e.value, ctx);
          if (!binds) continue;
          const scope = Object.create(env);
          for (const k of Object.keys(binds)) scope[k.toLowerCase()] = binds[k];
          return evalNode(arm.body, scope, ctx, builtins);
        }
        throw e;                 // not ours: let it keep going up
      }
    }

    // A structure's declarations run in a scope of their own and are then
    // published. Pulled out because local, functor and structure all do it.
    case 'Local': {
      const store = (ctx && ctx.session) || {};
      const inner = Object.create(env);
      for (const d of node.hidden) evalNode(d, inner, { ...ctx, session: inner }, builtins);
      // D-06: `local … in … end` BINDS, so it should report what it bound.
      // It was implemented as an anonymous structure and echoed as one:
      // `structure local : 1 name(s)`, which tells you nothing about `vis`.
      const names = [];
      const values = [];
      for (const d of node.shown) {
        evalNode(d, inner, { ...ctx, session: inner }, builtins);
        if (d.name) {
          const v = inner[d.name.toLowerCase()];
          store[d.name.toLowerCase()] = v;
          names.push(d.name);
          values.push(v);
        }
      }
      if (names.length === 1) return { tag: 'binding', name: names[0], value: values[0] };
      if (names.length > 1) return { tag: 'bindings', names, values };
      return { tag: 'unit' };
    }

    case 'FunctorDecl': {
      const store = (ctx && ctx.session) || {};
      (store.__functors = store.__functors || {})[node.name] = { param: node.param, decls: node.decls };
      return { tag: 'functor', name: node.name, param: node.param };
    }

    case 'StructApply': {
      const store = (ctx && ctx.session) || {};
      const f = (store.__functors || {})[node.functor];
      if (!f) throw new RonmlError(`${node.functor} is not a functor`);
      const inner = Object.create(env);
      // The argument's names are visible inside the body both bare and under
      // the parameter's name, so `X.size` and `size` both find it.
      const prefix = `${String(node.arg || '').toLowerCase()}.`;
      for (const k of Object.keys(store)) {
        if (!k.startsWith(prefix)) continue;
        const bare = k.slice(prefix.length);
        inner[bare] = store[k];
        inner[`${f.param.toLowerCase()}.${bare}`] = store[k];
      }
      for (const d of f.decls) evalNode(d, inner, { ...ctx, session: inner }, builtins);
      const allowed = node.ascribe ? ((store.__sigs || {})[node.ascribe] || null) : null;
      const published = [];
      for (const k of Object.keys(inner)) {
        if (k.startsWith('__') || k.includes('.')) continue;
        if (allowed && !allowed.some((n) => n.toLowerCase() === k)) continue;
        store[`${node.name.toLowerCase()}.${k}`] = inner[k];
        published.push(k);
      }
      return { tag: 'struct', name: node.name, names: published };
    }

    // Fixity is applied at parse time; this persists it so the NEXT line parsed
    // in this session sees it too.
    // A chain of simultaneous declarations. Evaluated in order into the same
    // environment, which is what makes `fun ev … and od …` mutually recursive:
    // both land in the session before either is called.
    case 'Decls': {
      // `and` is SIMULTANEOUS. Every right-hand side sees the bindings that
      // were in scope BEFORE the declaration, which is the whole difference
      // between `val a = 1 and b = a` and two declarations in a row. v1.278
      // built the chain by running the parts in sequence, so each right-hand
      // side saw the ones before it and `val u = 2 and w = u` gave w the new u.
      //
      // Every case in the corpus is independent or mutually recursive
      // definitions, where the two readings agree, which is why the conformance
      // number never noticed. Shadowing is where they part.
      //
      // `fun` chains are the exception and must NOT be held back: mutual
      // recursion needs each name in scope while the others are defined. They
      // bind functions, and a function's body is not run at definition, so
      // letting them see each other is both necessary and harmless.
      const isFun = node.sequential
        || node.items.every((d) => d && d.type === 'TopLet' && d.value && d.value.type === 'Lam');
      if (isFun) {
        const fnames = [];
        const fvalues = [];
        let last = { tag: 'unit' };
        for (const d of node.items) {
          last = evalNode(d, env, ctx, builtins);
          if (last && last.tag === 'binding') { fnames.push(last.name); fvalues.push(last.value); }
        }
        if (fnames.length > 1) return { tag: 'bindings', names: fnames, values: fvalues };
        return last;
      }
      // Value bindings: work out every right-hand side first, against the
      // environment as it stands, and only then put the names in.
      const staged = node.items.map((d) => {
        if (d && d.type === 'TopLet') {
          return { d, v: evalNode(d.value, env, ctx, builtins) };
        }
        return { d, v: null };
      });
      // D-08: report EVERY binding the chain made, not just the last one. Both
      // names always bound correctly; only the echo dropped them, so
      // `val a = 1 and b = 2` answered `val b = 2` and left you wondering about a.
      const names = [];
      const values = [];
      let last = { tag: 'unit' };
      for (const { d, v } of staged) {
        if (v !== null && d.type === 'TopLet') {
          env[d.name.toLowerCase()] = v;
          names.push(d.name);
          values.push(v);
          last = { tag: 'binding', name: d.name, value: v };
        } else {
          last = evalNode(d, env, ctx, builtins);
        }
      }
      if (names.length > 1) return { tag: 'bindings', names, values };
      return last;
    }

    // `open S` copies a structure's published names into scope without their
    // prefix. The members are stored flat as `s.member`, so this is a scan for
    // that prefix and a copy — the same shape the structure case writes.
    // `while c do e` answers unit and is there for its effects: a ref being
    // assigned, something printed. Bounded by the same step budget as anything
    // else, so a loop that never ends faults rather than hanging.
    case 'While': {
      for (;;) {
        const c = evalNode(node.cond, env, ctx, builtins);
        if (!c || c.tag !== 'bool') throw new RonmlError(`${describeValue(c)} is not true or false`);
        if (!c.v) return { tag: 'unit' };
        // Each turn evaluates the condition and the body, and evalNode counts a
        // step on entry, so the budget bounds the loop without extra plumbing:
        // a while that never ends faults rather than hanging.
        evalNode(node.body, env, ctx, builtins);
      }
    }

    case 'OpenDecl': {
      const store = (ctx && ctx.session) || {};
      const opened = [];
      for (const name of node.names) {
        const pre = `${name.toLowerCase()}.`;
        let found = 0;
        for (let e = store; e && e !== Object.prototype; e = Object.getPrototypeOf(e)) {
          for (const k of Object.keys(e)) {
            if (!k.startsWith(pre)) continue;
            const bare = k.slice(pre.length);
            if (bare.includes('.')) continue;      // a nested structure stays qualified
            if (!(bare in env)) { env[bare] = e[k]; found++; }
          }
        }
        // Constructors too: `open` on a structure holding a datatype brings its
        // constructors, which is most of why anyone opens anything.
        const cons = store.__cons || {};
        for (const k of Object.keys(cons)) {
          if (k.toLowerCase().startsWith(pre)) {
            cons[k.slice(pre.length)] = cons[k];
            found++;
          }
        }
        if (!found) throw new RonmlError(`no structure ${name} to open`);
        opened.push(name);
      }
      return { tag: 'struct', name: opened.join(' '), names: [] };
    }

    case 'FixityDecl': {
      const store = (ctx && ctx.session) || {};
      const tbl = (store.__fixity = store.__fixity || defaultFixity());
      for (const n of node.names) {
        if (node.word === 'nonfix') delete tbl[n];
        else tbl[n] = [node.prec, node.assoc];
      }
      return { tag: 'unit' };
    }

    case 'SigDecl': {
      const store = (ctx && ctx.session) || {};
      (store.__sigs = store.__sigs || {})[node.name] = node.names;
      return { tag: 'sig', name: node.name, names: node.names };
    }

    // `signature B = A where type … = …`: B inherits A's public names. The
    // where-type refinement is a no-op here, since signatures track names and
    // not types.
    case 'SigAbbrev': {
      const store = (ctx && ctx.session) || {};
      const names = (store.__sigs || {})[node.from];
      if (!names) throw new RonmlError(`no signature ${node.from} to name`);
      (store.__sigs = store.__sigs || {})[node.name] = names;
      return { tag: 'sig', name: node.name, names };
    }

    // A structure runs its declarations in a scope of their own and then
    // publishes them under a prefix, so `Board.size` finds what `size` became.
    // `:>` publishes only the names the signature lists, which is the real work
    // a signature does even without a checker behind it: everything else stays
    // inside, and a caller reaching for it does not find it.
    case 'StructDecl': {
      const store = (ctx && ctx.session) || {};
      const inner = Object.create(env);
      for (const d of node.decls) evalNode(d, inner, { ...ctx, session: inner }, builtins);
      const allowed = node.ascribe ? ((store.__sigs || {})[node.ascribe] || null) : null;
      const published = [];
      for (const k of Object.keys(inner)) {
        if (k.startsWith('__')) continue;
        const bare = k;
        if (allowed && !allowed.some((n) => n.toLowerCase() === bare)) continue;
        store[`${node.name.toLowerCase()}.${bare}`] = inner[k];
        published.push(bare);
      }
      // Constructors declared inside are visible through the prefix too.
      const icons = inner.__cons || {};
      const reg = (store.__cons = store.__cons || {});
      for (const c of Object.keys(icons)) reg[c] = icons[c];
      return { tag: 'struct', name: node.name, names: published };
    }

    case 'Datatype': {
      const store = (ctx && ctx.session) || {};
      const reg = (store.__cons = store.__cons || {});
      for (const c of node.cons) {
        reg[c.name] = { name: c.name, arity: c.arity, of: node.name };
        store[c.name.toLowerCase()] = c.arity === 0
          ? { tag: 'con', name: c.name, args: [] }
          : { tag: 'confn', name: c.name, arity: c.arity, args: [] };
      }
      return { tag: 'datatype', name: node.name, cons: node.cons.map((c) => c.name) };
    }

    // The eliminator. Arms are tried in order and the first that matches wins,
    // which is what lets you put the base case first and read the thing like
    // the definition it is.
    case 'Case': {
      const v = evalNode(node.subject, env, ctx, builtins);
      for (const arm of node.arms) {
        const binds = matchPattern(arm.pat, v, ctx);
        if (binds) {
          const scope = Object.create(env);
          for (const k of Object.keys(binds)) scope[k.toLowerCase()] = binds[k];
          return evalNode(arm.body, scope, ctx, builtins);
        }
      }
      throw new RonmlError(`no case matches ${describeValue(v)} — add an arm, or _ => … to catch the rest`);
    }
    case 'Var': {
      const lower = node.name.toLowerCase();
      // Walk the scope chain (envs nest via Object.create for let/lambda scopes),
      // stopping before Object.prototype so `toString` etc. never resolve as vars.
      // hasOwnProperty alone missed grandparent bindings (nested closures).
      for (let e = env; e && e !== Object.prototype; e = Object.getPrototypeOf(e)) {
        if (Object.prototype.hasOwnProperty.call(e, lower)) return e[lower];
      }
      // nil is the empty list, and the name matters: it is the base case every
      // recursion over a list stops at. [] is the same value, written the other
      // way, exactly as ML has both.
      if (lower === 'nil') return { tag: 'list', items: [] };
      if (lower === 'true') return { tag: 'bool', v: true };
      if (lower === 'false') return { tag: 'bool', v: false };
      const b = builtins[lower];
      if (b) {
        if (b.arity === 0) return b.fn([], ctx);
        return { tag: 'fn', name: lower, builtin: b, args: [], ctx };
      }
      // A real verb from the OTHER system, typed at this terminal: it just isn't
      // a command here (the two systems don't know each other). Distinct from a
      // plain node id like OB_XXXX or an atom like berries, which stay nodes.
      // Ask the HOST whether it wants to say something about a name it knows.
      // In NostOS this is "that verb belongs to the other system"; the language
      // itself has no verbs and no stations, so it asks rather than knows.
      // (M2, v1.287: this was a direct read of the game's ALL_VERBS table.)
      if (HOST_NAME_HINT) {
        const hint = HOST_NAME_HINT(node.name, ctx);
        if (hint) throw new RonmlError(hint);
      }
      // AN UNBOUND NAME IS AN ERROR. Standard ML has no bare atoms: a name that
      // was never bound cannot be a value.
      //
      // It used to become one here, an atom spelling itself, which is a game-ism
      // that survived the cut into src/lang/. NostOS needs bare words as values
      // (a node code OB_1A2B, a filename foo.ml) and the language inherited the
      // rule wholesale. The cost was three silent defects: `val x = notbound`
      // bound the typo and said nothing, and a name hidden behind an opaque
      // signature came back as the atom `T.hidden` instead of being refused,
      // which made both `:>` and signature abbreviation look like they worked.
      //
      // The host may still have the behaviour, by answering this hook. NostOS
      // does; the standalone language does not, and refuses.
      if (HOST_UNBOUND) {
        const v = HOST_UNBOUND(node.name, ctx);
        if (v) return v;
      }
      throw new RonmlError(`unbound variable: ${node.name}`);
    }
    // Several bindings in one `let`, sharing a single scope so they can refer to
    // one another. See the note in the parser: nesting them meant the first
    // could not see the second.
    case 'LetRec': {
      const env2 = Object.create(env);
      for (const b of node.binds) env2[b.name.toLowerCase()] = evalNode(b.value, env2, ctx, builtins);
      return evalNode(node.body, env2, ctx, builtins);
    }

    case 'Let': {
      // RECURSIVE, like SML's `fun`: the scope is created first and the name is
      // bound into it before the value is evaluated, so `let f x = … f … in …`
      // can call itself. (The top-level `let` was already recursive; this makes
      // the two agree, and it is what a machine's program needs — a program is
      // one expression, with no top level to recurse at.)
      const env2 = Object.create(env);
      env2[node.name.toLowerCase()] = evalNode(node.value, env2, ctx, builtins);
      return evalNode(node.body, env2, ctx, builtins);
    }
    case 'TopLet': {
      // Bare top-level `let x = e`: evaluate `e`, then persist the binding into
      // the session env the REPL handed us as the base `env` (main.js passes
      // `ctx.session`), so the next line entered can read `x`. Echoes `val x = …`.
      const v = evalNode(node.value, env, ctx, builtins);
      env[node.name.toLowerCase()] = v;
      return { tag: 'binding', name: node.name, value: v };
    }
    case 'LetPat': {
      const v = evalNode(node.value, env, ctx, builtins);
      const binds = matchPattern(node.pat, v, ctx);
      if (!binds) throw new RonmlError(`this binding does not fit ${describeValue(v)}`);
      const env2 = Object.create(env);
      for (const k of Object.keys(binds)) env2[k.toLowerCase()] = binds[k];
      return evalNode(node.body, env2, ctx, builtins);
    }
    case 'TopLetPat': {
      const v = evalNode(node.value, env, ctx, builtins);
      const binds = matchPattern(node.pat, v, ctx);
      if (!binds) throw new RonmlError(`this binding does not fit ${describeValue(v)}`);
      const names = Object.keys(binds);
      for (const k of names) env[k.toLowerCase()] = binds[k];
      // Echo every name it bound, the way the top level echoes one.
      return { tag: 'bindings', names, values: names.map((k) => binds[k]) };
    }
    case 'App': {
      const fn = evalNode(node.fn, env, ctx, builtins);
      const arg = evalNode(node.arg, env, ctx, builtins);
      // The closure case is inlined rather than going through applyValue,
      // because it is the hot path of every recursive program and the host
      // frame it saves is the difference between a deep continuation-passing
      // program running and exhausting the host stack. Harper's N-queens in
      // continuation-passing style sits close enough to that line to notice.
      if (fn && fn.tag === 'closure') {
        const env2 = Object.create(fn.env);
        env2[fn.param.toLowerCase()] = arg;
        return evalNode(fn.body, env2, fn.ctx, fn.builtins);
      }
      return applyValue(fn, arg);
    }
    default:
      throw new RonmlError('malformed command');
  }
}


// Match a value against a pattern. Returns a map of bindings, or null if the
// pattern does not fit. Harper (1993, p.16): "the variables in a pattern are
// not references to previously-bound variables, but rather variables that are
// about to be bound by pattern-matching." That sentence is the whole function.
function matchPattern(pat, v, ctx) {
  const cons = (ctx && ctx.session && ctx.session.__cons) || {};
  switch (pat.p) {
    case 'wild': return {};
    case 'unit': return v && v.tag === 'unit' ? {} : null;
    case 'num': return v && (v.tag === 'int' || v.tag === 'real') && v.v === pat.v ? {} : null;
    case 'char': return v && v.tag === 'char' && v.v === pat.v ? {} : null;
    case 'str': return v && v.tag === 'str' && v.v === pat.v ? {} : null;
    case 'bool': return v && v.tag === 'bool' && v.v === pat.v ? {} : null;
    case 'nil': return v && v.tag === 'list' && v.items.length === 0 ? {} : null;
    case 'cons': {
      if (!v || v.tag !== 'list' || !v.items.length) return null;
      const h = matchPattern(pat.head, v.items[0], ctx);
      if (!h) return null;
      const t = matchPattern(pat.tail, { tag: 'list', items: v.items.slice(1) }, ctx);
      return t ? { ...h, ...t } : null;
    }
    case 'as': {
      const m = matchPattern(pat.pat, v, ctx);
      return m ? { ...m, [pat.name]: v } : null;
    }
    // An annotation is the checker's business, not the matcher's.
    case 'ann': return matchPattern(pat.pat, v, ctx);
    case 'record': {
      if (!v || v.tag !== 'record') return null;
      const out = {};
      for (const f of pat.fields) {
        if (!Object.prototype.hasOwnProperty.call(v.fields, f.label)) return null;
        const m = matchPattern(f.pat, v.fields[f.label], ctx);
        if (!m) return null;
        Object.assign(out, m);
      }
      // Without `...` the pattern must account for every field, as in ML.
      if (!pat.open && Object.keys(v.fields).length !== pat.fields.length) return null;
      return out;
    }
    case 'tuple': {
      if (!v || v.tag !== 'tuple' || v.items.length !== pat.items.length) return null;
      const out = {};
      for (let i = 0; i < pat.items.length; i++) {
        const m = matchPattern(pat.items[i], v.items[i], ctx);
        if (!m) return null;
        Object.assign(out, m);
      }
      return out;
    }
    case 'name': {
      // A declared constructor matches by name and arity; anything else is a
      // variable, and a variable matches anything.
      if (cons[pat.name]) {
        if (!v || (v.tag !== 'con' && v.tag !== 'confn') || v.name !== pat.name) return null;
        const got = v.args || [];
        // `P (a, b)` and `P a b` are both written for a constructor carrying two
        // things — the first is Standard ML's, the second is what this build's
        // own documentation teaches. Both match: a single tuple pattern of the
        // right width is spread across the constructor's arguments.
        if (pat.args.length === 1 && got.length > 1
            && pat.args[0].p === 'tuple' && pat.args[0].items.length === got.length) {
          const out2 = {};
          for (let i = 0; i < got.length; i++) {
            const m = matchPattern(pat.args[0].items[i], got[i], ctx);
            if (!m) return null;
            Object.assign(out2, m);
          }
          return out2;
        }
        if (pat.args.length !== got.length) return null;
        const out = {};
        for (let i = 0; i < pat.args.length; i++) {
          const m = matchPattern(pat.args[i], got[i], ctx);
          if (!m) return null;
          Object.assign(out, m);
        }
        return out;
      }
      if (pat.args.length) return null;   // `Foo x` where Foo is not a constructor
      return { [pat.name]: v };
    }
    default: return null;
  }
}

// TYPE ANNOTATIONS, AND WHAT THIS MACHINE DOES WITH THEM.
//
// Standard ML checks an annotation before anything runs. This build cannot:
// inference is a whole-program analysis and a console has one line at a time,
// with the next not yet written. The tempting shortcut is to parse annotations
// and throw them away, so a file copied out of a manual runs. That is worse
// than refusing them, because `val x : int = "hello"` would then be accepted
// and hand you a string: the annotation would say something the machine had no
// intention of honouring.
//
// So they are honoured, LATE. The annotation is checked when the value arrives
// rather than before the program runs, which is the actual difference between a
// compiler and a console, and is worth a player knowing. A type this build has
// no opinion about (a function type, a type variable, a datatype you declared)
// is carried and not checked, which is stated rather than hidden.
const TYPE_TAGS = {
  int: 'num', real: 'num', word: 'num',
  string: 'str', char: 'str',
  bool: 'bool', unit: 'unit', list: 'list',
};

function checkType(ann, v, what) {
  if (!ann) return v;
  const want = TYPE_TAGS[ann.toLowerCase()];
  if (!want) return v;                       // nothing this build can judge
  if (!v || v.tag !== want) {
    throw new RonmlError(`${what} is annotated ${ann} but the value is ${describeValue(v)}`);
  }
  return v;
}

export function describeValue(v) {
  if (!v) return 'nothing';
  switch (v.tag) {
    case 'unit': return '()';
    case 'int': return `the whole number ${v.v}`;
    case 'real': return `the real ${v.v}`;
    case 'char': return `the character ${v.v}`;
    case 'bool': return v.v ? 'true' : 'false';
    case 'node': return `node ${v.id}`;
    case 'key': return v.kind === 'aikey' ? 'the AI key' : 'a key';
    case 'file': return `the file ${v.name}`;
    case 'list': return 'a list';
    case 'tuple': return `a tuple of ${v.items.length}`;
    case 'record': return `a record of {${Object.keys(v.fields).join(', ')}}`;
    case 'select': return `#${v.label}`;
    case 'con': return `${v.name}`;
    case 'confn': return `${v.name} (needs ${v.arity - v.args.length} more)`;
    case 'datatype': return `the type ${v.name}`;
    case 'functor': return `the functor ${v.name}`;
    case 'binding': return `the binding ${v.name}`;
    case 'bindings': return `${v.names.length} bindings`;
    case 'fn': return `${v.name} (needs ${v.builtin.arity - v.args.length} more arg${v.builtin.arity - v.args.length === 1 ? '' : 's'})`;
    default: return 'that';
  }
}

// Standard ML prints a string and a character WITH their delimiters — `"hi"`,
// `#"a"` — and this build printed both bare, so `#"a"`, `"a"` and a variable
// named `a` all echoed as `a`. Invisible inside the game, where the surrounding
// text says which you are looking at; obvious the moment there is a REPL.
//
// It cannot simply be switched on. A NostOS verb returns a `str` exactly like an
// ML string does, so quoting every answer would make an obelisk print
// `"CALYPSO"` where it used to print `CALYPSO`. So the printer takes a mode and
// the HOST picks: the REPL asks for Standard ML's shape, the game keeps its own.
// Same argument as advisory-versus-strict, and the same answer.
function quoted(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r');
}

// The answer as Standard ML would write it. Differs from formatValue only in
// strings and characters, and recursively inside anything holding them.
export function formatAnswer(v) {
  if (!v) return '()';
  switch (v.tag) {
    case 'char': return `#"${quoted(v.v)}"`;
    case 'str': return `"${quoted(v.v)}"`;
    case 'list': return '[' + v.items.map(formatAnswer).join(', ') + ']';
    case 'tuple': return '(' + v.items.map(formatAnswer).join(', ') + ')';
    case 'record': return '{' + Object.keys(v.fields).map((k) => `${k} = ${formatAnswer(v.fields[k])}`).join(', ') + '}';
    case 'ref': return `ref ${formatAnswer(v.cell.v)}`;
    case 'con': {
      if (!v.args || !v.args.length) return v.name;
      const arg = (a) => (a && a.tag === 'con' && a.args && a.args.length ? `(${formatAnswer(a)})` : formatAnswer(a));
      if (v.args.length > 1) return `${v.name} (${v.args.map(formatAnswer).join(', ')})`;
      return `${v.name} ${v.args.map(arg).join(' ')}`;
    }
    case 'binding': return `val ${v.name} = ${formatAnswer(v.value)}`;
    case 'bindings': return v.names.map((n, i) => `val ${n} = ${formatAnswer(v.values[i])}`).join('\n');
    default: return formatValue(v);
  }
}

export function formatValue(v) {
  if (!v) return '()';
  switch (v.tag) {
    case 'unit': return '()';
    // Standard ML writes a negative number with a tilde, not a minus: `~3`,
    // `~1.5`. The minus sign is the binary operator and nothing else.
    case 'int': return String(v.v).replace(/^-/, '~');
    case 'real': return (Number.isInteger(v.v) ? `${v.v}.0` : String(v.v)).replace(/^-/, '~');
    case 'char': return v.v;
    case 'bool': return v.v ? 'true' : 'false';
    case 'str': return v.v;
    case 'node': return v.id;
    case 'key': return v.kind === 'aikey' ? (v.enc === false ? 'AIKEY:open' : 'AIKEY:sealed') : `KEY:${v.id}`;
    case 'file': return v.name;
    case 'list': return '[' + v.items.map(formatValue).join(', ') + ']';
    case 'tuple': return '(' + v.items.map(formatValue).join(', ') + ')';
    case 'record': return '{' + Object.keys(v.fields).map((k) => `${k} = ${formatValue(v.fields[k])}`).join(', ') + '}';
    case 'select': return `#${v.label}`;
    // A constructor's arguments are parenthesised when they are themselves
    // constructors carrying something, or `Plus (Chr "a") (Chr "b")` prints as
    // `Plus Chr a Chr b`, which reads as four arguments and is not what it is.
    case 'ref': return `ref ${formatValue(v.cell.v)}`;
    case 'con': {
      if (!v.args || !v.args.length) return v.name;
      const arg = (a) => (a && a.tag === 'con' && a.args && a.args.length ? `(${formatValue(a)})` : formatValue(a));
      // More than one thing carried is one tuple, and Standard ML prints it as
      // one: `P (1, 2)`, not `P 1 2`. A single argument stays bare.
      if (v.args.length > 1) return `${v.name} (${v.args.map(formatValue).join(', ')})`;
      return `${v.name} ${v.args.map(arg).join(' ')}`;
    }
    case 'confn': return `<${v.name}>`;
    case 'datatype': return `datatype ${v.name} = ${v.cons.join(' | ')}`;
    case 'typename': return `type ${v.name}`;
    case 'exndecl': return `exception ${v.name}`;
    case 'sig': return `signature ${v.name} = sig ${v.names.join(' ')} end`;
    case 'struct': return `structure ${v.name} : ${v.names.length} name(s)`;
    case 'functor': return `functor ${v.name} (${v.param})`;
    case 'binding': return `val ${v.name} = ${formatValue(v.value)}`;
    case 'bindings': return v.names.map((n, i) => `val ${n} = ${formatValue(v.values[i])}`).join('\n');
    case 'closure': return '<fn>';
    case 'fn': return `<${describeValue(v)}>`;
    default: return String(v);
  }
}

// Join anything `echo` printed during evaluation with the expression's final value.
// If the program printed and its final value is unit (the usual case for an
// echo/`;` sequence), show only the printed lines — no trailing "()". Otherwise the
// printed lines come first, then the value.
// `sml` picks the printer for the ANSWER only. Anything already in `out` came
// from `echo`, which prints what it was given: `print "hi"` writes hi, in
// Standard ML too.
export function combineOutput(out, result, sml) {
  const tail = sml ? formatAnswer(result) : formatValue(result);
  if (!out || !out.length) return tail;
  if (result && result.tag === 'unit') return out.join('\n');
  return out.join('\n') + '\n' + tail;
}

// Usage hints for a builtin left short of its full argument count — shown
// as the teaching error instead of a cryptic partial-function value, per the
