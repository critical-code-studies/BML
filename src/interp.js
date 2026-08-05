// THE INTERPRETER. The one entry point, and the thing a host holds.
//
// Part of src/lang/. Written at v1.288 (M3) out of what was `runRonml` in
// src/game/ai_ml.js. See docs/aiml-standalone-plan.md §4.
//
// WHAT THIS FILE IS FOR. Before it, the entry point mixed two jobs: reading and
// running a line of ML, and being NostOS's console (intercepting `help`, picking
// a verb table by station, wording an error as "isn't a command on this
// terminal"). The first job is the language. The second belongs to whoever is
// hosting it. `createInterpreter` takes the second as OPTIONS, so the game
// passes its four station tables and its wording, and the command-line REPL
// passes almost nothing.
//
// THE RULE THE HOOKS FOLLOW, and it is the one M2 arrived at: the language calls
// host policy, it never reads host tables. Every hook below is a question the
// language asks and the host answers. None of them lets the host reach in.

import { RonmlError, RonmlRaise } from './errors.js';
import { tokenize } from './lex.js';
import { parse, joinProgramLines } from './parse.js';
import { evalNode, formatValue, combineOutput, beginRun, setOut } from './eval.js';
import { typeOf, remember } from './types.js';
import { diagnose } from './diag.js';
import { PRELUDE } from './basis.js';
import { PRIMITIVES } from './prims.js';

// SML'S TOP-LEVEL ANSWER. Standard ML replies `val it = 7 : int` — the name it
// bound, the value, and the type. A declaration already names itself (`val f =
// <fn>`, `datatype t = A | B`), so only a bare expression needs `it` put in
// front of it. Pure, so the shape can be tested without a terminal to type at.
const DECLARES = /^(val|fun|datatype|type|exception|signature|structure|functor) /;
export function smlEcho(text, ty) {
  if (!text) return [];
  // No type to show (the checker is off, or it could not say): print as before.
  if (!ty || ty.startsWith('TYPE:')) return [text];
  const [tyOnly, warn] = ty.split('    WARNING: ');
  const line = DECLARES.test(text) ? `${text} : ${tyOnly}` : `val it = ${text} : ${tyOnly}`;
  return warn ? [line, `  WARNING: ${warn}`] : [line];
}

/**
 * Make an interpreter.
 *
 * opts.builtins    the host's verbs. An object, or a function (hostCtx) => object
 *                  when the host serves several different sets — NostOS picks by
 *                  station, so it passes the function.
 * opts.typecheck   'off'    — do not run the checker at all
 *                  'report' — infer, name a clash, run the line anyway
 *                  'strict' — refuse a line that does not typecheck (SML's own
 *                             behaviour, and the default here)
 * opts.session     an existing bindings object to continue in, if the host is
 *                  keeping one of its own.
 * opts.hooks       host policy, all optional:
 *   unknownName(name, hostCtx)  -> string | null
 *       A bare word at the top level that is not bound, not a constructor and
 *       not a verb. Return the message to use, or null to take the language's
 *       own ("unbound variable: x"). NostOS answers "that is a HERMES command,
 *       not an obelisk one", and answers null inside a machine's own program,
 *       where a bare word is the intent it chose rather than a typo.
 *   needsMoreArgs(fnValue, hostCtx) -> string | null
 *       A line whose whole result is a partly-applied verb. The host usually
 *       knows how the verb is meant to be called.
 */
// Which names a declaration binds at the top level. Only these two node types
// write into the environment; see the two `env[...] =` sites in eval.js.
function topLevelNames(ast) {
  if (!ast) return [];
  // The node names are read from eval.js, not guessed: the first version of
  // this said 'LetPat', which does not exist, so `val (a, b) = …` bound over
  // the top of a captured frame exactly as before.
  if (ast.type === 'TopLet') return [String(ast.name).toLowerCase()];
  if (ast.type === 'TopLetPat') return patternNames(ast.pat).map((n) => n.toLowerCase());
  return [];
}

// Every name a pattern binds. Walked GENERICALLY rather than by listing the
// node shapes, because the first version of this listed shapes that did not
// exist ('PVar', 'PAs') and so found nothing in `val (a, b) = …`, which left
// tuple bindings still overwriting what a closure had captured. The pattern
// types are lowercase and there are a dozen of them; recursing over every
// object-valued field cannot fall behind a new one.
//
// This over-approximates: a constructor in a pattern (`val SOME x = …`) also
// looks like a name here. The cost of a false positive is one extra frame on
// the chain, which is correct behaviour and a little memory; the cost of a
// false negative is the bug this exists to fix.
function patternNames(pat, out = []) {
  if (!pat || typeof pat !== 'object') return out;
  if (typeof pat.name === 'string') out.push(pat.name);
  for (const k of Object.keys(pat)) {
    if (k === 'name' || k === 'type') continue;
    const v = pat[k];
    if (Array.isArray(v)) v.forEach((x) => patternNames(x, out));
    else if (v && typeof v === 'object') patternNames(v, out);
  }
  return out;
}

// Flatten a session to a plain object a host can serialise.
//
// TWO THINGS ARE WRONG WITH SAVING THE RAW OBJECT, and this fixes both.
//
// The chain. Top-level rebindings live on prototype-linked frames (see
// `envTip` below), and JSON.stringify takes own properties only, so saving the
// raw session drops every binding made after a name was reused. This walks the
// chain with for..in and takes the visible value of each name.
//
// The closures. A closure holds the environment it captured, which holds the
// closure, so a session with a function in it CANNOT be stringified at all. In
// NostOS that was a live bug and a quiet one: `player.laptop` goes into the
// save blob, so defining a function at the NostBook made JSON.stringify throw,
// the throw was swallowed by the `catch { }` around localStorage, and the game
// stopped saving without saying so. A closure could never have been restored
// from JSON in any case, so the honest thing is to leave it out.
//
// The test is empirical rather than a list of tags: anything that survives a
// round trip is kept, anything that does not is dropped. A list would go stale
// the first time a value type gained a function field.
export function flattenSession(session) {
  const out = {};
  if (!session) return out;
  const tip = session.__env || session;
  for (const k in tip) {
    if (k === '__env') continue;
    try {
      JSON.stringify(tip[k]);
      out[k] = tip[k];
    } catch {
      // A function, or something holding one. It cannot come back from a save.
    }
  }
  return out;
}

export function createInterpreter(opts = {}) {
  const typecheck = opts.typecheck || 'strict';
  // The language's own primitives first, the host's verbs over the top. A host
  // may shadow one by name; NostOS does not, but the order says which wins.
  // Before v1.288 there were no language primitives at all and `hd` was a game
  // verb, so the prelude could not load without the game.
  const hostBuiltins = typeof opts.builtins === 'function'
    ? opts.builtins
    : () => (opts.builtins || {});
  // opts.primitives: false lets a host that does its OWN filtering supply the
  // set itself. NostOS does: it hands each station a different slice, so an
  // obelisk control terminal has no `explode` and never did. Such a host is
  // expected to source the definitions from prims.js rather than write its own,
  // and the adapter does.
  const usePrims = opts.primitives !== false;
  const builtinsFor = (hostCtx) => (usePrims
    ? { ...PRIMITIVES, ...hostBuiltins(hostCtx) }
    : hostBuiltins(hostCtx));
  // opts.printing: 'sml' quotes strings and characters in the ANSWER, as
  // Standard ML does; 'bare' prints them raw. Defaults to SML's shape for the
  // same reason typecheck defaults strict — this is an ML unless a host says
  // otherwise — and NostOS says otherwise, because its verbs return strings
  // and an obelisk should print CALYPSO rather than "CALYPSO".
  const sml = (opts.printing || 'sml') === 'sml';
  const hooks = opts.hooks || {};
  const session = opts.session || {};

  // THE ENVIRONMENT TIP, and why there is one.
  //
  // A top-level binding used to be written straight into the session object, so
  // rebinding a name overwrote the slot an existing closure was still reading:
  //
  //   val n = 10
  //   fun addn m = m + n
  //   val n = 99
  //   addn 1            (* 100 here; Standard ML says 11 *)
  //
  // `Lam` captures its environment correctly and `Let` already opens a scope
  // with Object.create, so the fault was only ever the top level. A rebinding
  // now opens a new frame on the chain instead of writing over the old one:
  // closures made earlier keep reading the frame they captured, and later
  // lookups walk the chain and find the newer value first.
  //
  // The tip lives ON the session rather than in a local, because NostOS builds
  // a fresh interpreter per line around the same session object, and a local
  // would be thrown away between lines. The session stays the ROOT of the
  // chain, so anything the host writes to it directly is still visible.
  const envTip = () => session.__env || session;

  // What the checker makes of a line, as a string to print beside the answer.
  // Never throws and never refuses: inference here REPORTS, and a name it has
  // never seen is "anything" rather than an error. Whether the line then runs is
  // decided by `typecheck`, above, not here.
  function typeReport(source) {
    if (typecheck === 'off') return null;
    try {
      // Parse with the SESSION's fixity, exactly as run() does below. Reading
      // the line a second time with a different table is how the checker came to
      // reject `2 plus 3` after `infix 6 plus`: it saw an application of 2 to
      // two arguments, which is ill-typed, while the evaluator saw the operator
      // the user had just declared. Same text, two grammars.
      const ast = parse(tokenize(String(source)), session.__fixity || undefined);
      const r = typeOf(ast, envTip());
      if (!r.ok) return r.error ? `TYPE: ${r.error}` : null;
      remember(ast, envTip(), r.t);
      // A warning rides alongside the type rather than replacing it: the line is
      // well typed and also has a hole in it, and you want to be told both.
      if (r.warnings && r.warnings.length) return `${r.type}    WARNING: ${r.warnings.join('; ')}`;
      return r.type;
    } catch {
      return null;         // unparseable is the parser's business, not this one's
    }
  }

  function run(source, hostCtx) {
    // The host's context travels untouched to every builtin. The interpreter
    // adds only what the language itself needs to find: the session it is
    // running in, so a builtin that binds a name binds it in the right place.
    const ctx = { ...(hostCtx || {}), session };
    try {
      // STRICT MODE. In Standard ML a program that does not typecheck does not
      // run — that is the whole point of the type system, and until this existed
      // the honest claim was that the language *infers* types, not that it *is*
      // typed. Same checker, same message as 'report'; the only difference is
      // whether the line then runs. Warnings stay warnings under both.
      // CHECK whenever the checker is on, not only when it can refuse. Under
      // 'report' this used to skip typeReport entirely, so a caller that used
      // `run` alone recorded no types at all and a structure declared at the
      // prompt was never walked. The REPL happened to work because bin/bml.js
      // calls typeReport itself first; anyone using this as a library got
      // silence. Calling it here costs a second idempotent pass for those
      // callers and removes the trap for everyone else.
      if (typecheck !== 'off') {
        const ty = typeReport(source);
        if (typecheck === 'strict' && ty && ty.startsWith('TYPE:')) {
          return { ok: false, text: `ERR: ${ty.slice(6).trim()}` };
        }
      }
      const toks = tokenize(source);
      // Nothing but comments and space is EMPTY INPUT, not a broken command.
      // In Standard ML a comment is whitespace.
      if (!toks.length || (toks.length === 1 && toks[0].t === 'EOF')) return { ok: true, text: '' };
      // The session's fixity table, so `infix 8 OR` on an earlier line changes
      // how this one reads.
      const ast = parse(toks, session.__fixity || undefined);
      const builtins = builtinsFor(hostCtx);

      // A bare word typed as a WHOLE line that is neither a verb nor a known
      // binding is a typo rather than a value. This fires ONLY at the top level:
      // arguments still evaluate to atoms exactly as before.
      if (ast && ast.type === 'Var' && /^[a-z][a-z0-9]*$/i.test(ast.name)) {
        const lower = ast.name.toLowerCase();
        const bound = lower in envTip();
        const cons = session.__cons || {};
        const isCon = Object.prototype.hasOwnProperty.call(cons, ast.name);
        if (!bound && !isCon && !builtins[lower]
            && lower !== 'true' && lower !== 'false' && lower !== 'nil') {
          const said = hooks.unknownName ? hooks.unknownName(ast.name, hostCtx) : undefined;
          // undefined means "no opinion, use the language's own words"; null
          // means "let it through", which is what a machine's own program wants,
          // where a bare word is the intent it chose.
          if (said) return { ok: false, text: `ERR: ${said}` };
          if (said === undefined) return { ok: false, text: `ERR: unbound variable: ${ast.name}` };
        }
      }

      // Fresh output buffer for this line: `echo` pushes into it mid-evaluation,
      // so a `;`-sequence or a recursive echo prints every step rather than only
      // the final value.
      // A top-level binding of a name already in scope opens a new frame, so
      // the old one survives for whoever captured it. Only `TopLet` and
      // `LetPat` write into the environment; everything else (datatypes,
      // fixity, structures) keeps its own registry on the session root.
      const rebound = topLevelNames(ast).filter((n) => n in envTip());
      if (rebound.length) session.__env = Object.create(envTip());

      const out = [];
      setOut(out);
      beginRun(hostCtx && hostCtx.fuel);
      const result = evalNode(ast, envTip(), ctx, builtins);
      if (result && result.tag === 'fn') {
        const hint = hooks.needsMoreArgs && hooks.needsMoreArgs(result, hostCtx);
        return { ok: false, text: `ERR: ${hint || `${result.name} needs more arguments`}` };
      }
      // NOT `{..., value: result}`, though §4 of the plan sketches it that way.
      // A closure's value holds the environment it captured, which holds the
      // closure, so any caller that stringifies a result hits a cycle — one did
      // the moment it was added. When something actually needs the raw value it
      // can have a separate call that says so.
      return { ok: true, text: combineOutput(out, result, sml) };
    } catch (e) {
      if (e instanceof RonmlRaise) {
        return { ok: false, text: `ERR: uncaught exception ${formatValue(e.value)}` };
      }
      // A JavaScript stack overflow means one thing here: a program that
      // recursed without ever coming back. The step budget is supposed to catch
      // that first, but the two are in a race — a deeply nested (non-tail)
      // recursion uses several host frames per step, so on a small stack the
      // host loses. Report it as what it is rather than leaking the engine's own
      // words.
      if (e instanceof RangeError && /call stack/i.test(e.message || '')) {
        return { ok: false, text: 'ERR: step budget exceeded — this recursion never comes back' };
      }
      // If the line is a piece of Standard ML this build does not have, say
      // which piece, because the parser's own message names the character it
      // choked on and that helps nobody.
      const why = diagnose(source);
      if (why) return { ok: false, text: `ERR: ${why}` };
      if (e instanceof RonmlError) return { ok: false, text: `ERR: ${e.message}` };
      return { ok: false, text: `ERR: ${e.message || 'malformed command'}` };
    }
  }

  // Load the standard library into this session. Cheap enough to do on the first
  // line typed, and skipped afterwards. A prelude line that fails is a bug in
  // the prelude rather than a player error, so it is swallowed here — and walked
  // by a test, because swallowed also means invisible.
  function loadPrelude(hostCtx) {
    if (session.__prelude) return;
    session.__prelude = true;
    for (const line of joinProgramLines(PRELUDE)) {
      try {
        run(line, hostCtx);
      } catch { /* see above */ }
    }
  }

  return { run, typeReport, loadPrelude, smlEcho, session, typecheck, env: envTip };
}
