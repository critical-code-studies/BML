// AI-ML: the small functional language typed into an obelisk terminal, a
// HERMES relay, the NostBook, and carried by a machine as its own program.
// Design: docs/ob-terminal-language.md.
//
// LINEAGE. This is a descendant of Standard ML, and the resemblance is meant
// to survive inspection: `let` and `let ... in`, `fn x => e` lambdas, named
// functions applied by juxtaposition, recursion, and lists built from `nil`
// and `::`. Harper's Introduction to Standard ML (1986-1993) is the reference
// the design keeps returning to; where this language departs from it, the
// departure is deliberate and noted at the point it happens.
//
// WHAT IT DROPS, and why. No type system: the machine this runs on has no
// compiler, only an interpreter, and a survivor typing at a dead console gets
// their error when the thing runs, not before. No pattern matcher: matching in
// ML is the eliminator for constructors declared with `datatype`, and there is
// no `datatype` here, so a matcher would have nothing to take apart but lists
// and would buy syntax rather than power. `hd`, `tl` and `length` do that job.
// No `map` or `filter`: with recursion you can write them, and writing them is
// what this machine is for.
//
// Runtime values are tagged objects, never raw JS primitives, so error
// messages can name what went wrong:
//   {tag:'node', id}   {tag:'key', id}   {tag:'num', v}
//   {tag:'list', items}  {tag:'unit'}   {tag:'fn', name, builtin, args}

import { typeOf, remember } from '../lang/types.js';
import {
  evalNode, applyValue, formatValue, describeValue, combineOutput,
  beginRun, setHostNameHint,
} from '../lang/eval.js';

const numericTag = (x) => !!x && (x.tag === 'int' || x.tag === 'real');

export { RonmlError, RonmlFuelError, RonmlRaise } from '../lang/errors.js';
import { RonmlError, RonmlFuelError, RonmlRaise } from '../lang/errors.js';

// The current run's print buffer. `echo` pushes into it as it evaluates and the
// two entry points (runRonml / runStar) install a fresh one per line, so output
// arrives in order even from deep inside a recursion. Module-level on purpose:
// closures capture the ctx of the line that defined them, so a per-ctx buffer
// silently swallowed output from any function called on a LATER line.
let OUT = null;


// ---- The language proper lives in src/lang/ --------------------------------
//
// M1 (v1.286) moved the lexer and the parser out. Everything below this point
// is the ADAPTER: the verb tables for the four stations, the sensors, the robot
// contract, the game's help and survey wording. Nothing here is the language.
//
// The re-exports are load-bearing: seven files import these names from this
// module, and the standing rule in docs/aiml-standalone-plan.md is that the
// adapter RE-EXPORTS and never copies. Two definitions of the same thing is how
// the diagnostic list went stale six times.
import { tokenize } from '../lang/lex.js';
import { parse, parseLine, joinProgram, joinProgramLines, defaultFixity } from '../lang/parse.js';

export { parseLine, joinProgram, joinProgramLines, defaultFixity };

// What a unit's lamp can be set to. A machine of this vintage has one LED and
// a handful of drive levels, not a colour picker, so the set is short and named.
export const LAMP_COLOURS = ['red', 'amber', 'green', 'blue', 'white', 'off'];

// Effects a program can have on its own machine as it evaluates. Collected in
// EFFECTS (module-level, like OUT, because closures capture the defining ctx —
// see the echo bug) and drained by decide(). The engine decides whether to
// honour any of them; the language only records the request.
let EFFECTS = null;
function EFFECT(kind, arity, build) {
  return {
    arity,
    fn: (args) => {
      const extra = build(args) || {};
      if (EFFECTS) EFFECTS.push({ k: kind, ...extra });
      return { tag: 'unit' };
    },
  };
}

// A sensor: reads one field out of the snapshot the engine handed in. Missing
// readings are not an error — a machine with a broken sensor reports zero or
// false, and a program written against it still runs.
function SENSE(field, kind) {
  return {
    arity: 0,
    fn: (_args, ctx) => {
      const v = ctx && ctx.sense ? ctx.sense[field] : undefined;
      return kind === 'bool' ? { tag: 'bool', v: !!v } : { tag: 'int', v: Number(v) || 0 };
    },
  };
}

// ---- Builtins ----------------------------------------------------------
// Each `ctx` method is supplied by the caller (main.js) and does the actual
// world-mutation; this module only handles language mechanics and gating.

// `copy <file> <device>` — the arity-2 second half of the polymorphic `copy`.
// `copy` (below) returns a partial bound to this when its first arg is a file,
// so `copy factory_id.ml ob` moves the file, while `copy aikey` stays the
// arity-1 key-bind. ctx.copyFile does the world-side move and returns {ok,msg}.
const COPY_FILE = {
  arity: 2,
  fn: ([file, dest], ctx) => {
    if (!file || file.tag !== 'file') throw new RonmlError('copy needs a file first — try: copy factory_id.ml ob');
    const destName = (dest && dest.id) ? String(dest.id).toLowerCase() : '';
    if (!destName) throw new RonmlError('copy a file WHERE? — try: copy factory_id.ml ob');
    if (!ctx.copyFile) throw new RonmlError("you can't move files at this terminal.");
    const r = ctx.copyFile(file.name, destName);
    if (!r || !r.ok) throw new RonmlError((r && r.msg) || `couldn't copy ${file.name}.`);
    return { tag: 'file', name: file.name };
  },
};

function makeBuiltins(station) {
  const B = {
    scan: {
      arity: 0,
      fn: (_args, ctx) => ({ tag: 'list', items: ctx.listObelisks().map((id) => ({ tag: 'node', id })) }),
    },
    keys: {
      arity: 0,
      fn: (_args, ctx) => ({ tag: 'list', items: [...ctx.heldKeys()].map((id) => ({ tag: 'key', id })) }),
    },
    repel: {
      arity: 0,
      fn: (_args, ctx) => { ctx.repelNearby(); return { tag: 'unit' }; },
    },
    sing: {
      arity: 0,
      fn: (_args, ctx) => { ctx.sing(); return { tag: 'unit' }; },
    },
    map: {
      arity: 0,
      fn: (_args, ctx) => { ctx.showMap(); return { tag: 'unit' }; },
    },
    // `print <topic>` at an obelisk: `print map` runs off a carryable map;
    // `print aikey` stamps a fresh physical AI key at your feet (you must be
    // holding one — a spare against losing it). The HERMES relay overrides
    // `print` to take a document topic (see makeBuiltins).
    print: {
      arity: 1,
      fn: ([topic], ctx) => {
        const raw = topic && (topic.kind === 'aikey' ? 'aikey' : (topic.id || '')) || '';
        const name = String(raw).toLowerCase();
        if (name === 'aikey' || name === 'key') ctx.printKey();
        else if (name === 'map' || name === 'territory') ctx.printMap();
        else throw new RonmlError('print needs a topic — try: print map   or   print aikey');
        return { tag: 'unit' };
      },
    },
    // `copy aikey`: read the AI key you physically hold and bind it into the
    // session under the name you gave (usually `aikey`), so the rest of the
    // language can use it — the bridge from your pack to the console. Returns a
    // SEALED AI-key value; `decrypt` opens it. Fails if you hold no AI key.
    copy: {
      arity: 1,
      fn: ([what], ctx) => {
        // Polymorphic on the first argument.
        //  - a FILE (foo.ml)      -> `copy <file> <device>`: a partial bound to
        //    COPY_FILE that the next atom (the device) completes.
        //  - `aikey`/`card`/`key` -> the classic key-bind: bind the held AI key
        //    into the session as a sealed token for decrypt/unlock.
        //  - any OTHER bare word  -> a filename someone typed without its
        //    extension (players type `copy zeus_lightning card`, not
        //    `zeus_lightning.ml`): treat it as a file too, and let COPY_FILE + the
        //    fs resolve the extension. Forgiving beats a misleading error.
        if (what && what.tag === 'file') {
          return { tag: 'fn', name: 'copy', builtin: COPY_FILE, args: [what], ctx };
        }
        // The name may already be BOUND in the session — a previous `copy aikey`
        // or `copy card` binds `aikey`, so the SECOND `copy aikey` resolves the
        // bound key TOKEN, not the literal word, and used to fall through to a
        // baffling "copy what?" (while `copy card`, unbound, still worked). Accept
        // an already-sealed AI-key token and just re-affirm it.
        if (what && what.tag === 'key' && what.kind === 'aikey') {
          if (!ctx.hasAiKey || !ctx.hasAiKey()) {
            throw new RonmlError('nothing to copy — you are not holding an AI key. (a wrecked W-factory drops one.)');
          }
          const token = { tag: 'key', kind: 'aikey', enc: true };
          if (ctx.bindSession) ctx.bindSession('aikey', token);
          return token;
        }
        const id = (what && what.id ? String(what.id) : '').toLowerCase();
        if (id === 'aikey' || id === 'card' || id === 'key') {
          if (!ctx.hasAiKey || !ctx.hasAiKey()) {
            throw new RonmlError('nothing to copy — you are not holding an AI key. (a wrecked W-factory drops one.)');
          }
          const token = { tag: 'key', kind: 'aikey', enc: true };
          if (ctx.bindSession) ctx.bindSession(id === 'key' ? 'aikey' : id, token);
          return token;
        }
        if (id) {
          return { tag: 'fn', name: 'copy', builtin: COPY_FILE, args: [{ tag: 'file', name: id }], ctx };
        }
        throw new RonmlError('copy what? — try: copy <file> <drive>   or   copy aikey');
      },
    },
    // `cd <device>` / `ls`: the RON-DOS drive navigation. Devices are the AI key
    // you hold (cd aikey / cd card), the obelisk's scratch bench (cd ob), and a
    // HERMES relay's folder (cd hermes). `ls` lists the current device's files.
    // ctx supplies cd/ls (main.js) — where the file state actually lives.
    cd: {
      arity: 1,
      fn: ([dev], ctx) => {
        const name = (dev && (dev.id || dev.name)) ? String(dev.id || dev.name).toLowerCase() : '';
        if (!name) throw new RonmlError('cd needs a drive — try: cd card  ·  cd ob  (drives lists them)');
        if (!ctx.cd) throw new RonmlError('no drives at this terminal.');
        const r = ctx.cd(name);
        if (!r || !r.ok) throw new RonmlError((r && r.msg) || `no drive '${name}' here — try: drives`);
        return r.label ? { tag: 'node', id: `» ${r.label}` } : { tag: 'unit' }; // echo which drive + card state
      },
    },
    // `drives`: list the drives attached here (ob / card / hermes) and, crucially,
    // the card's CURRENT name — so you can always tell what state it's in.
    drives: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.drives) throw new RonmlError('no drives at this terminal.');
        ctx.drives();
        return { tag: 'unit' };
      },
    },
    ls: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.ls) throw new RonmlError('no drives at this terminal.');
        return { tag: 'list', items: (ctx.ls() || []).map((n) => ({ tag: 'file', name: n })) };
      },
    },
    // `decrypt aikey`: turn a sealed AI key (from `copy`) into the open token
    // `unlock` needs. The AI encrypts its own masters out of habit; this undoes it.
    decrypt: {
      arity: 1,
      fn: ([k], ctx) => {
        if (!k || k.tag !== 'key' || k.kind !== 'aikey') {
          throw new RonmlError('decrypt needs the AI key. copy it in first: copy aikey');
        }
        return { tag: 'key', kind: 'aikey', enc: false };
      },
    },
    // `echo`: PRINT a value — ML's `print`. It emits to the run's output buffer as a
    // side effect (mid-evaluation, so a recursive `echo n ; go (n-1)` prints every
    // step as it counts) and returns unit, not the string. runRonml/runStar join the
    // buffer with the final value for display.
    //
    // The buffer is module-level (OUT), deliberately NOT hung off `ctx`: a closure
    // captures the ctx of the line that DEFINED it, and the hub builds a fresh ctx
    // per command, so `let f = fn x => echo x` on one line and `f "hi"` on the next
    // pushed into the previous line's dead buffer and printed nothing.
    echo: {
      arity: 1,
      fn: ([x]) => {
        if (OUT) OUT.push(formatValue(x));
        return { tag: 'unit' };
      },
    },
    // ---- taking a list apart ------------------------------------------
    // The language could make lists from the day it had `scan`, and could do
    // nothing with one: a program could be handed a list and had no way in.
    // These three close that, and they are the language's own rather than any
    // station's, so a robot's program can use them with no network at all.
    // Deliberately not `map`/`filter`: with recursion these are enough to
    // write those yourself, which is the sort of thing this machine is for.
    // ---- the little that stands in for a standard library ------------
    // A machine with no floating-point unit and no printer does not get one,
    // but these five come up in every worked example and cost nothing.
    abs: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: n.tag, v: Math.abs(n.v) }; } },
    sqrt: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); if (n.v < 0) throw new RonmlError('sqrt of a negative'); return { tag: 'real', v: Math.sqrt(n.v) }; } },
    // int and real do not mix, so there have to be ways across.
    real: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'real', v: n.v }; } },
    floor: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'int', v: Math.floor(n.v) }; } },
    // characters
    ord: { arity: 1, fn: ([c]) => { if (!c || c.tag !== 'char') throw new RonmlError(`${describeValue(c)} is not a character`); return { tag: 'int', v: c.v.charCodeAt(0) }; } },
    chr: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'char', v: String.fromCharCode(n.v) }; } },
    // WHAT THE CARD CAN HEAR. Not the control wire — this is the NostBook's own
    // wireless card reading traffic off the air, the same table `arp -a` prints.
    // A machine broadcasts to its tower whether or not anyone is listening, so
    // listening costs nothing and gives itself away to nobody.
    units: {
      arity: 0,
      fn: (_args, ctx) => ({
        tag: 'list',
        items: ((ctx && ctx.units && ctx.units()) || []).map((u) => ({
          tag: 'record',
          fields: {
            name: { tag: 'str', v: String(u.name) },
            range: { tag: 'int', v: Number(u.range) || 0 },
            bearing: { tag: 'str', v: String(u.bearing) },
            kind: { tag: 'str', v: String(u.kind || '?') },
          },
        })),
      }),
    },
    str: { arity: 1, fn: ([c]) => { if (!c || c.tag !== 'char') throw new RonmlError(`${describeValue(c)} is not a character`); return { tag: 'str', v: c.v }; } },
    explode: { arity: 1, fn: ([x]) => { if (!x || x.tag !== 'str') throw new RonmlError(`${describeValue(x)} is not a string`); return { tag: 'list', items: [...x.v].map((ch) => ({ tag: 'char', v: ch })) }; } },
    implode: { arity: 1, fn: ([l]) => { if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`); return { tag: 'str', v: l.items.map((c) => (c && c.tag === 'char' ? c.v : formatValue(c))).join('') }; } },
    min: { arity: 2, fn: ([a, b]) => { if (!a || !numericTag(a) || !b || !numericTag(b)) throw new RonmlError('min needs two numbers'); return { tag: a.tag, v: Math.min(a.v, b.v) }; } },
    max: { arity: 2, fn: ([a, b]) => { if (!a || !numericTag(a) || !b || !numericTag(b)) throw new RonmlError('max needs two numbers'); return { tag: a.tag, v: Math.max(a.v, b.v) }; } },
    size: { arity: 1, fn: ([x]) => { if (x && x.tag === 'str') return { tag: 'int', v: x.v.length }; if (x && x.tag === 'list') return { tag: 'int', v: x.items.length }; throw new RonmlError(`${describeValue(x)} has no size`); } },
    // A cell whose contents can be replaced. The only mutable thing here.
    ref: { arity: 1, fn: ([v]) => ({ tag: 'ref', cell: { v } }) },
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
    // ---- a machine's own senses (docs/robot-programs-plan.md §2) ----------
    // Nullary builtins reading the unit's state off ctx.sense. Functions, not
    // fields, so the language needs no records and no `.` accessor — and being
    // station-scoped means a unit's program cannot reach the network by mistake.
    charge: SENSE('charge', 'num'),
    integrity: SENSE('integrity', 'num'),
    range: SENSE('range', 'num'),
    home_range: SENSE('home_range', 'num'),
    threat: SENSE('threat', 'bool'),
    hurt: SENSE('hurt', 'bool'),
    linked: SENSE('linked', 'bool'),
    blight: SENSE('blight', 'bool'),
    daylight: SENSE('daylight', 'bool'),
    // ---- fire control (P8) ----------------------------------------------
    // The level below `hunt`. A machine that carries a weapon has to know
    // whether it can see the target, whether it is loaded, whether the target
    // is behind something, whether it is being touched, and how long it has
    // been looking without finding anything.
    sight: SENSE('sight', 'bool'),
    armed: SENSE('armed', 'bool'),
    shielded: SENSE('shielded', 'bool'),
    contact: SENSE('contact', 'bool'),
    lost_for: SENSE('lost_for', 'num'),
    // ---- a machine's own EFFECTS ----------------------------------------
    // Sensors read; these do. They are not intents: a program still evaluates
    // to exactly one intent, and these happen along the way, exactly like
    // `echo` at a console. `beep ; if threat then hunt else patrol` sounds the
    // buzzer and then decides, and because they sit inside branches, a unit can
    // be made to announce only the thing you care about:
    //     if threat then (beep ; eye "white" ; hunt) else patrol
    // The engine collects them (decide returns them) and is free to refuse:
    // beeping is rate-limited and inaudible from across the island.
    beep: EFFECT('beep', 0, () => ({})),
    eye: EFFECT('eye', 1, ([c]) => {
      const name = String(c && c.v != null ? c.v : c && c.id != null ? c.id : '').toLowerCase();
      if (!LAMP_COLOURS.includes(name)) {
        throw new RonmlError(`no such lamp colour: ${name || '?'} — try ${LAMP_COLOURS.join(' · ')}`);
      }
      return { colour: name };
    }),
    flash: EFFECT('flash', 1, ([n]) => {
      const hz = Number(n && n.v);
      if (!Number.isFinite(hz) || hz < 0 || hz > 10) throw new RonmlError('flash takes a rate from 0 to 10 (0 is steady)');
      return { hz };
    }),
    // `timer`: how long until POSEIDON comes online — a free read off the network
    // clock, so you can pace the run from the console.
    timer: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.poseidonTimer) throw new RonmlError('no clock on this wire.');
        return { tag: 'node', id: ctx.poseidonTimer() };
      },
    },
    // `name`: the code of the obelisk you are jacked into — a free read, so you
    // can see which node you're on without scrolling the boot banner.
    name: {
      arity: 0,
      fn: (_args, ctx) => {
        const id = ctx.currentNode && ctx.currentNode();
        if (!id) throw new RonmlError('no node here.');
        return { tag: 'node', id };
      },
    },
    // Opens the browsable notepad overlay (ctx.showNotepad, main.js) rather
    // than printing to the console — a real page you flip through, not a
    // wall of scrollback.
    // (The `notes` verb was removed from the console — press N for the notepad.)
    // ELIZA has two faces. Bare `eliza` / `run eliza` opens the 1966 DOCTOR as
    // an interactive chat — that is intercepted in the REPL (main.js), not here,
    // since it is a mode, not a value. `eliza <file>` is the TRANSFORM: feed a
    // file through the DOCTOR's reflection and get a new file back. On the
    // factory's id line (`I am W-FACTORY, my keys are mine`) the my->your
    // reflection turns the boast into a grant — root_access.ml. (Calypso escape
    // chain, docs/calypso-escape-chain.md.)
    eliza: {
      arity: 1,
      fn: ([file], ctx) => {
        if (!file || file.tag !== 'file') {
          throw new RonmlError('eliza needs a file to transform — try: eliza factory_id.ml  (or `eliza` alone to talk to the DOCTOR)');
        }
        if (!ctx.elizaTransform) throw new RonmlError('no ELIZA image on this node.');
        const r = ctx.elizaTransform(file.name);
        if (!r || !r.ok) throw new RonmlError((r && r.msg) || `ELIZA can do nothing with ${file.name}.`);
        return { tag: 'file', name: r.out };
      },
    },
    // `retire` (R3): with the hermes card, stand the fortress guards down — they
    // become gardeners instead of hunters. The refunction-by-command payoff.
    retire: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.retire) throw new RonmlError('nothing to retire from this terminal.');
        ctx.retire();
        return { tag: 'unit' };
      },
    },
    // ---- HERMES station verbs (RON hilltop relays only) ------------------
    // RON tech is off-grid on purpose: no network verb (touching the wire would
    // give the relay away). It is the human record — read it, print a copy — AND
    // a maker's bench that forges only from what you carry in (see `forge`), so
    // the no-wire rule holds while the relay still arms Zeus's command. (A HERMES
    // `print` is added in makeBuiltins below, so it can take a topic; the
    // obelisk's own arity-0 `print` maps the network.)
    read: {
      arity: 1,
      fn: ([topic], ctx) => {
        // Accept a doc topic (read history) or a file (read readme.md) — file
        // values carry .name, topics come through as .id/node.
        const name = topic && (topic.name || topic.id || '') || '';
        ctx.read(String(name).toLowerCase());
        return { tag: 'unit' };
      },
    },
    // `forge zeus_virus.ml` (HERMES relay): arm the sealed payload with the two
    // credentials on your Trojan card -> zeus_lightning.ml on the relay bench.
    // The relay stays off the wire; it forges only from what you carry in.
    forge: {
      arity: 1,
      fn: ([file], ctx) => {
        if (!file || file.tag !== 'file') throw new RonmlError('forge needs the payload file — try: forge zeus_virus.ml');
        if (!ctx.forge) throw new RonmlError('nothing to forge at this terminal.');
        const r = ctx.forge(file.name);
        if (!r || !r.ok) throw new RonmlError((r && r.msg) || `can't forge ${file.name}.`);
        return { tag: 'file', name: r.out };
      },
    },
    // Lists the human knowledge this relay still holds — RON kept it alive when
    // the machines were deleting it.
    archive: {
      arity: 0,
      fn: (_args, ctx) => { ctx.archive(); return { tag: 'unit' }; },
    },
    // Pull the next of RON's own field records off the relay mesh into your
    // Scrapbook — the half of the record RON kept on its relays, not in caches.
    records: {
      arity: 0,
      fn: (_args, ctx) => { ctx.records(); return { tag: 'unit' }; },
    },
    // Override a nearby machine and see through its eyes — RON turning the
    // enemy's own units. You drive it until it leaves the relay's short range
    // or you trip its self-destruct.
    drive: {
      arity: 0,
      fn: (_args, ctx) => { ctx.drive(); return { tag: 'unit' }; },
    },
    // `backup aikey` / `restore aikey`: RON's relays keep a copy of your AI key
    // off the AI's hardware, so losing it (death, a fumble) needn't cost you the
    // endgame. The `aikey` word is the thing being backed up; its value is not
    // needed (the check is whether you physically hold / have backed up a key).
    backup: {
      arity: 1,
      fn: (_args, ctx) => { ctx.backup(); return { tag: 'unit' }; },
    },
    restore: {
      arity: 1,
      fn: (_args, ctx) => { ctx.restore(); return { tag: 'unit' }; },
    },
    nearest: {
      arity: 1,
      fn: ([list], ctx) => {
        if (!list || list.tag !== 'list') throw new RonmlError('nearest needs a list — try: scan |> nearest');
        if (!list.items.length) throw new RonmlError('nothing in range to pick from');
        let best = null, bestD = Infinity;
        for (const item of list.items) {
          if (item.tag !== 'node') throw new RonmlError('nearest only works on a list of nodes');
          const d = ctx.distanceToNode(item.id);
          if (d < bestD) { bestD = d; best = item; }
        }
        return best;
      },
    },
    hack: {
      arity: 1,
      fn: ([node], ctx) => {
        if (!node || node.tag !== 'node') throw new RonmlError('hack needs a node — try: hack OB_XXXX');
        // No AI key needed to hack a node's own key — the access chip that got
        // you into this console is enough. crash therefore needs no AI key
        // either (it only wants the key hack hands back). The AI key still
        // gates the sharper verbs (sleep/rewind/repel) and the fortress unlock.
        if (!ctx.nodeExists(node.id)) throw new RonmlError(`no node ${node.id} on the wire`);
        ctx.recordHack(node.id);
        return { tag: 'key', id: node.id };
      },
    },
    crash: {
      arity: 2,
      fn: ([node, key], ctx) => {
        if (!node || node.tag !== 'node') throw new RonmlError('crash needs a node first — try: crash OB_XXXX k');
        const label = node.id || 'OB_XXXX';
        if (!key || key.tag !== 'key' || key.id !== node.id) {
          throw new RonmlError(`crash needs ${label}'s own key. try: let k = hack ${label} in crash ${label} k`);
        }
        if (!ctx.nodeExists(node.id)) throw new RonmlError(`${label} is already dark`);
        ctx.crashNode(node.id);
        return { tag: 'unit' };
      },
    },
    // The easy way in: one word, one node, no key. Pins an infinite loop
    // into the node instead of physically felling it — it and its garrison
    // freeze where they stand, burning CPU, until a repair drone eventually
    // resets it. Weaker than crash (nothing is destroyed, and it self-heals
    // on its own schedule) but far cheaper to pull off.
    loop: {
      arity: 1,
      fn: ([node], ctx) => {
        if (!node || node.tag !== 'node') throw new RonmlError('loop needs a node — try: loop OB_XXXX');
        const label = node.id || 'OB_XXXX';
        if (!ctx.nodeExists(node.id)) throw new RonmlError(`no node ${label} on the wire`);
        if (ctx.nodeFrozen(node.id)) throw new RonmlError(`${label} is already looping — it needs a repair drone, not a second one`);
        ctx.loopNode(node.id);
        return { tag: 'unit' };
      },
    },
    sleep: {
      arity: 1,
      fn: ([num], ctx) => {
        if (!num || num.tag !== 'num') throw new RonmlError('sleep needs a number of minutes — try: sleep 30');
        ctx.sleepNearby(num.v);
        return { tag: 'unit' };
      },
    },
    // Claws hours back off the POSEIDON deadline — the resistance's own clock
    // sabotage, buying more time before the towers link up for the purge.
    // Only meaningful before the purge starts; once POSEIDON is actually live
    // the deadline clock isn't running anymore, so ctx reports back if so.
    rewind: {
      arity: 1,
      fn: ([num], ctx) => {
        if (!num || num.tag !== 'num') throw new RonmlError('rewind needs a number of hours — try: rewind 3');
        if (ctx.skylinkActive()) throw new RonmlError('POSEIDON is already live — the deadline clock isn\'t running anymore. Knock towers dark instead.');
        ctx.rewindClock(num.v);
        return { tag: 'unit' };
      },
    },
    // Extract a fortress key from the network using a node key you hacked — the
    // program that actually earns its keep: `let k = hack OB_XXXX in unlock k`.
    // The argument must be a key from hack; it drops a single fortress key.
    // `unlock k d`: the endgame program. `k` is a key hacked off a live node
    // (`hack`), `d` is the DECRYPTED AI key (`copy aikey` then `decrypt aikey`).
    // Both together drop a fortress key; either alone is refused with a hint.
    unlock: {
      arity: 2,
      fn: ([key, dec], ctx) => {
        if (!key || key.tag !== 'key' || key.kind === 'aikey') {
          throw new RonmlError('unlock needs a hacked node key first. try: let k = hack OB_XXXX in unlock k d');
        }
        if (!dec || dec.tag !== 'key' || dec.kind !== 'aikey') {
          throw new RonmlError('unlock needs the AI key too. copy it in and decrypt it: copy aikey  then  let d = decrypt aikey');
        }
        if (dec.enc !== false) {
          throw new RonmlError('that AI key is still sealed. decrypt it first: let d = decrypt aikey');
        }
        ctx.unlock(key.id);
        return { tag: 'unit' };
      },
    },
  };
  // The obelisk (TIRESIAS) and the HERMES relay are two different systems, each
  // with its own commands — not one language that refuses half its verbs. So we
  // hand back only the verbs that belong to the station you're at. A verb from
  // the other system simply isn't a command here (see evalNode's unknown path).
  // Neutral verbs (notes; help/let are handled outside this table) belong to
  // both. A station-less caller (tools/tests) gets everything.
  for (const k of OB_VERBS) if (B[k]) B[k].station = 'ob';
  for (const k of HERMES_VERBS) if (B[k]) B[k].station = 'hermes';
  // A unit's senses and service verbs belong to the unit. Untagged, they fell
  // through to every console below — you could ask an obelisk for its `charge`
  // and be told 0, or type `beep` at a relay and have it quietly succeed. They
  // are tagged here so those consoles say plainly that this is not their verb.
  // (`not` and `echo` are in ROBOT_VERBS too and stay neutral: they belong to
  // the language, not to any one machine.)
  for (const k of MACHINE_ONLY) if (B[k]) B[k].station = 'robot';
  if (!station) return B;
  // The laptop is the language WITHOUT the world: hand back only its own short
  // list, so no verb that needs a wire (or a drive, or a card) is even present.
  if (station === 'robot') {
    const bot = {};
    for (const k of ROBOT_VERBS) if (B[k]) bot[k] = { ...B[k], station: 'robot' };
    return bot;
  }
  if (station === 'laptop') {
    const lap = {};
    for (const k of LAPTOP_VERBS) if (B[k]) lap[k] = { ...B[k], station: 'laptop' };
    return lap;
  }
  const out = {};
  for (const k of Object.keys(B)) {
    if (!B[k].station || B[k].station === station) out[k] = B[k];
  }
  // A HERMES relay prints DOCUMENTS, not maps — override `print` here so it
  // takes a topic (`print fortress`). The obelisk keeps its own arity-0 `print`.
  if (station === 'hermes') {
    out.print = {
      arity: 1, station: 'hermes',
      fn: ([topic], ctx) => { ctx.printDoc(String((topic && topic.id) || '').toLowerCase()); return { tag: 'unit' }; },
    };
  }
  return out;
}

// Which verbs belong to which system. Used to filter each terminal's builtins,
// and to tell "not a command here" (a real verb, wrong system) apart from a
// plain bad word.
// `copy`, `cd`, `ls` are deliberately NOT listed here — they are neutral (work at
// both an obelisk and a HERMES relay), like `notes`. A verb tagged for one station
// is refused at the other; the file verbs must move files at either terminal.
const OB_VERBS = ['scan', 'nearest', 'keys', 'name', 'timer', 'echo', 'not', 'hack', 'crash', 'loop', 'sleep', 'rewind', 'repel', 'sing', 'map', 'print', 'decrypt', 'unlock', 'eliza', 'retire'];
// Note: HERMES's `print` is added as an override in makeBuiltins (it takes a
// topic), not tagged here — tagging it would steal the obelisk's own arity-0
// `print`. `print` is already in OB_VERBS, so ALL_VERBS still covers it.
const HERMES_VERBS = ['read', 'archive', 'records', 'drive', 'backup', 'restore', 'forge'];
// The LAPTOP is off the network by design (docs/laptop-plan.md), so it carries no
// station verbs at all — only `echo` and the language core (let / fn / if /
// arithmetic / `;` / recursion), which is exactly what makes it a place to LEARN
// the language rather than perform it under fire. A tower verb typed here is not a
// typo, it is a machine that isn't listening: evalNode says so and points at a tower.
const LAPTOP_VERBS = ['echo', 'not', 'hd', 'tl', 'length', 'abs', 'sqrt', 'min', 'max', 'size',
  'real', 'floor', 'ord', 'chr', 'str', 'explode', 'implode', 'ref', 'units'];
// A MACHINE'S OWN STATION. Its program runs here: senses in, an intent out, and
// nothing else within reach — no network, no files, no console verbs. That is
// not a restriction bolted on, it is what a unit actually has.
// What a machine's own program may say. `not` and `echo` are the language's,
// not the machine's, so they are listed here but stay neutral elsewhere.
const MACHINE_ONLY = ['charge', 'integrity', 'range', 'home_range',
  'threat', 'hurt', 'linked', 'blight', 'daylight', 'beep', 'eye', 'flash',
  // Fire control (docs/robot-programs-plan.md P8). A machine that shoots needs
  // to know whether it can see, whether it is loaded, whether the target is
  // covered, whether it is being touched, and how long it has been looking.
  'sight', 'armed', 'shielded', 'contact', 'lost_for'];
const ROBOT_VERBS = [...MACHINE_ONLY, 'not', 'echo', 'hd', 'tl', 'length', 'abs', 'sqrt', 'min', 'max', 'size',
  'real', 'floor', 'ord', 'chr', 'str', 'explode', 'implode'];
// Retired verbs kept only so typing one gives a clean "not a command" instead
// of a cryptic node error (make/ping were removed when TORs became info-only).
const RETIRED_VERBS = ['make', 'ping'];
// ROBOT_VERBS are in here too: a unit's own senses and service verbs are real
// words, so typing `beep` or `charge` at a console should say it is not a
// command HERE rather than quietly evaluating to a node id.
const ALL_VERBS = new Set([...OB_VERBS, ...HERMES_VERBS, ...RETIRED_VERBS, ...ROBOT_VERBS]);

// A real verb typed at the wrong machine. On the laptop that is not a mistake so
// much as the machine's whole nature — it is off the network — so say what the
// laptop IS for instead of just refusing.
function notHereMessage(name, station) {
  if (station === 'laptop') {
    return `no network on this machine. '${name}' needs a tower — practise the language here, run it there.`;
  }
  return `'${name}' isn't a command on this terminal.`;
}

// ---- The evaluator lives in src/lang/eval.js -------------------------------
//
// M2 (v1.287) moved it out. What the adapter still needs from it is imported at
// the top of this file; what the game supplies BACK to it is the host name
// hint, installed just below — the one place the evaluator used to read the
// game's verb tables directly.
setHostNameHint((name, ctx) => {
  // A real verb from the OTHER system, typed at this terminal: it just isn't a
  // command here (the two systems don't know each other). Distinct from a plain
  // node id like OB_XXXX or an atom like berries, which stay nodes.
  const lower = String(name).toLowerCase();
  if (ctx && ctx.station && ALL_VERBS.has(lower)) return notHereMessage(name, ctx.station);
  return null;
});
// design doc's "crash OB_BB05 alone -> ERR: crash needs a key..." example.
const USAGE_HINTS = {
  hack: 'hack needs a node. try: hack OB_XXXX',
  crash: "crash needs a node and its key. try: let k = hack OB_XXXX in crash OB_XXXX k",
  loop: 'loop needs a node. try: loop OB_XXXX',
  nearest: 'nearest needs a list. try: scan |> nearest',
  sleep: 'sleep needs a number of minutes. try: sleep 30',
  rewind: 'rewind needs a number of hours. try: rewind 3',
  copy: 'copy a key (copy aikey) or a file to a device (copy factory_id.ml ob)',
  cd: 'cd needs a device. try: cd aikey  ·  cd ob',
  eliza: 'eliza <file> transforms a file (eliza factory_id.ml); bare `eliza` opens the DOCTOR',
  decrypt: 'decrypt needs the AI key. try: copy aikey  then  decrypt aikey',
  unlock: 'unlock needs a hacked node key and the decrypted AI key. try: copy aikey / let k = hack OB_XXXX / let d = decrypt aikey / unlock k d',
  print: 'print needs a topic — at an obelisk: print map  or  print aikey; at a relay: print <document>',
  backup: 'backup needs a key — try: backup aikey',
  restore: 'restore needs a key — try: restore aikey',
  read: 'read needs a topic — try: read history (archive lists them)',
  forge: 'forge needs the payload — try: forge zeus_virus.ml (at a relay, Trojan card in hand)',
};

// `help` reference, shown when the operator types it at the terminal. Per-verb
// detail lines keyed by name; `sing` is deliberately omitted (it's a secret).
// Each row: [sig, type, desc, gate, station]. `station` scopes the verb to a
// terminal — 'ob' (AI obelisk / TIRESIAS), 'hermes' (RON relay), or '' for the
// verbs that work anywhere. `help` filters to the terminal you're at.
const HELP_VERBS = [
  ['scan', 'unit -> list', 'obelisks/machines in range of this terminal', '', 'ob'],
  ['nearest', 'list -> node', 'the closest element of a list', '', 'ob'],
  ['keys', 'unit -> list', 'the access keys you currently hold', '', 'ob'],
  ['name', 'unit -> node', 'the code of the obelisk you are jacked into', '', 'ob'],
  ['timer', 'unit -> node', 'time left until POSEIDON comes online', '', 'ob'],
  ['hack n', 'node -> key', "take node n's access key", 'no key needed', 'ob'],
  ['crash n k', 'node key -> unit', 'knock node n dark until a drone mends it', 'needs k from hack', 'ob'],
  ['loop n', 'node -> unit', 'pin an infinite loop into node n — freezes it and its garrison until a drone resets it', 'no key needed', 'ob'],
  ['sleep t', 'num -> unit', 'idle local machines for t game-minutes', 'no key needed', 'ob'],
  ['rewind t', 'num -> unit', 'claw t hours back off the POSEIDON deadline', 'before the purge only', 'ob'],
  ['repel', 'unit -> unit', 'nearby machines turn tail and flee you', 'no key needed', 'ob'],
  ['map', 'unit -> unit', 'show the territory map (obelisks, machines, mainframe)', '', 'ob'],
  ['print t', 'atom -> unit', 'print map (a carryable map) or print aikey (a spare AI key)', '', 'ob'],
  ['copy k', 'key -> key', 'copy the AI key you hold into the session as `aikey`', 'hold an AI key', ''],
  ['copy f d', 'file device -> file', 'copy a file onto a device — copy factory_id.ml ob', '', ''],
  ['cd d', 'device -> node', 'change drive — the console echoes which drive, and the card state (run `drives` to see what is attached here)', '', ''],
  ['drives', 'unit -> unit', "list the drives attached here and the card's current name", '', ''],
  ['ls', 'unit -> list', 'list the files on the current drive', '', ''],
  ['decrypt k', 'key -> key', 'open the sealed AI key so unlock can use it', 'hold an AI key', 'ob'],
  ['unlock k d', 'key key -> unit', 'legacy — the fortress gate opens to a Trojan card now (refunction your AI key)', 'superseded', 'ob'],
  ['eliza', 'file -> file', 'eliza <file> runs the DOCTOR transform on a file; bare `eliza` (or run eliza) opens the DOCTOR to talk to — quit to leave', '', 'ob'],
  ['retire', 'unit -> unit', "stand the fortress guards down — they become gardeners (needs the hermes card)", 'hermes card', 'ob'],
  ['read t', 'atom -> unit', 'read a document — read ronml / fortress / obelisks / robots / history / destroy', 'HERMES relay only', 'hermes'],
  ['print t', 'atom -> unit', 'print a copy of a document into your notepad (N)', 'HERMES relay only', 'hermes'],
  ['archive', 'unit -> unit', 'list the documents this relay holds', 'HERMES relay only', 'hermes'],
  ['records', 'unit -> unit', "pull the next of RON's own field records into your Scrapbook (J); repeat until dry", 'HERMES relay only', 'hermes'],
  ['drive', 'unit -> unit', 'override a nearby machine and see through its eyes — drive it till it leaves range', 'HERMES relay only', 'hermes'],
  ['backup aikey', 'key -> unit', "copy your AI key to RON's relay mesh — survives death", 'HERMES relay only', 'hermes'],
  ['restore aikey', 'key -> unit', 'mint a backed-up AI key back into your pack', 'HERMES relay only', 'hermes'],
  ['forge f', 'file -> file', 'forge zeus_virus.ml into zeus_lightning.ml from your Trojan card', 'HERMES relay, Trojan card', 'hermes'],
  ['help', 'unit -> unit', 'this reference, or `help <verb>` for one verb', '', ''],
];
// `help ml` — a one-screen tour of the language itself (as opposed to `help`,
// which lists the verbs). Overview + worked examples, hello-world first.
const ML_OVERVIEW = [
  'AI-ML — a tiny functional language (Standard ML flavour).',
  '',
  '  VALUES     30    "text"    true/false    OB_1A2B (a node)    [a, b] (a list)',
  '  A COMMAND  a verb and its args:   scan    hack OB_1A2B    sleep 30',
  '  BIND       let x = e in body    (top level: bare  let x = e,  no `in`)',
  '  PIPE       scan |> nearest |> crash    (feeds left into right)',
  '  FUNCTION   fn x => e  is a lambda;   let f x = e  names one',
  '  MATH       + - * /   and   ^ (join text)',
  '  COMPARE    == != < > <= >=   give true/false',
  '  CHOOSE     if c then a else b',
  '  PRINT      echo x   emits a line as it runs;   a ; b   runs a then b',
  '  * COMMAND  *scan   *timer   *print map    (literal args, BBC-Micro style)',
  '',
  '  hello world:    echo "hello world"',
  '  a greeting:     let greet = fn name => echo ("hi " ^ name)     then   greet "world"',
  '  count down:     let go n = if n == 0 then echo "liftoff" else (echo n ; go (n - 1))',
  '                  then   go 3     prints  3 / 2 / 1 / liftoff',
  '  factorial:      let fact n = if n == 0 then 1 else n * fact (n - 1)     then   fact 5',
  '  the hack chain: let k = hack OB_1A2B in crash OB_1A2B k',
  '',
  '  type `help` for the verb list, or `help <verb>` for one verb.',
].join('\n');

// The laptop's own `help`: it has no station verbs, so listing the terminal
// reference would only advertise commands the machine hasn't got. Show the
// LANGUAGE instead — which is what this machine is for.
const LAPTOP_HELP = [
  'AI-ML — this machine is off the network, so this is the language only.',
  '',
  '  echo x            print a line',
  '  a ; b             do a, then b',
  '  let x = e         bind a value (top level: no `in` needed)',
  '  fn x => e         a function      let f x = e   names one',
  '  if c then a else b',
  '  + - * /  math     ^  join text    == != < > <= >=  compare',
  '',
  '  the tower verbs (scan, hack, crash, …) need a wire. Practise here.',
  '  type `help ml` for the full tour with worked examples.',
  '  type `quit` to leave ML and go back to the shell.',
].join('\n');

function helpText(topic, station, hasManual) {
  if (topic === 'ml' || topic === 'lang' || topic === 'language') return ML_OVERVIEW;
  if (!topic && station === 'laptop') return LAPTOP_HELP;
  if (topic) {
    const row = HELP_VERBS.find((v) => v[0].split(' ')[0] === topic);
    if (!row) return `no help for '${topic}'. try: help  ·  help ml`;
    const [sig, type, desc, gate] = row;
    return `${sig}\n  : ${type}\n  ${desc}${gate ? `\n  (${gate})` : ''}`;
  }
  // Show only the verbs that work at the terminal you're actually at — an
  // obelisk (TIRESIAS) lists the AI-network verbs, a HERMES relay lists RON's.
  const here = HELP_VERBS.filter((v) => !v[4] || !station || v[4] === station);
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  // Imperative verbs — the do-it-now commands that don't compose — are shown with
  // a leading `*` (their BBC-Micro command form). The composable ML verbs (hack,
  // crash, copy, decrypt, unlock, nearest, eliza, echo, cd/ls) stay bare, since
  // they nest in `let`/pipes/functions. Both forms still run; this just teaches the
  // split by how the reference presents them.
  const IMPERATIVE = new Set([
    'scan', 'keys', 'name', 'timer', 'map', 'print', 'sleep', 'rewind', 'repel', 'sing', 'loop', 'retire',
    'read', 'make', 'archive', 'records', 'drive', 'backup', 'restore', 'forge',
  ]);
  const lines = here.map(([sig, , desc, gate]) => {
    const shown = IMPERATIVE.has(sig.split(' ')[0]) ? '*' + sig : sig;
    return `  ${pad(shown, 12)} ${desc}${gate ? `  [${gate}]` : ''}`;
  });
  const title = station === 'hermes' ? 'HERMES reference (RON relay)' : 'AI-ML reference';
  const example = station === 'hermes'
    ? '  e.g.  read moly      make berries      archive'
    : '  e.g.  scan |> nearest      let k = hack OB_1A2B in crash OB_1A2B k';
  const out = [
    title,
    ...lines,
    '',
    '  let x = e in body   bind a value      |>   pipe left into right',
    '  fn x => e  a function    let f x = e  names one    "text"  a string',
    '  + - * /  math    ^  join text    == != < >  compare    if c then a else b',
    '  echo x  print a line    a ; b  do a then b    *cmd arg  plain command (BBC style)',
    example,
    '  type `help ml` for a tour of the language + examples.',
  ];
  // If the player hasn't read the full manual yet, say so — this reference is
  // the short form, and the bound RON-DOS Operator's Manual is a real find
  // (teaches the language properly and unlocks console autocomplete).
  if (!hasManual) {
    out.push('', '  TIP: Read the OB Operator\'s Manual for full information.');
  }
  return out.join('\n');
}

// Runs one line of AI-ML against a world context. Returns
// {ok, text} — text is either the printed result or a "ERR: ..." message,
// always a teaching error per the design doc (never a raw stack trace).
// A `*`-command turns a tokenizer token into a LITERAL value — BBC-Micro filing
// semantics: `*print map` passes `map` as the literal topic, never evaluating it
// as the `map` verb, and `*crash OB k` would pass a literal `k`, not a binding.
function litTokenToValue(t) {
  if (t.t === 'STR') return { tag: 'str', v: t.v };
  if (t.t === 'NUM') return { tag: 'int', v: t.v };
  if (t.t === 'IDENT') return /\.(ml|md)$/i.test(t.v) ? { tag: 'file', name: t.v } : { tag: 'node', id: t.v };
  return { tag: 'node', id: String(t.v ?? t.t) };
}

// `*verb arg arg` — the BBC-style command form (see AI-ML design). The verb is a
// builtin; its arguments are LITERAL tokens, not ML expressions (no `let`, no
// pipes, no variable lookup), which is what separates a command from the ML.
function runStar(rest, ctx) {
  let toks;
  try { toks = tokenize(rest).filter((t) => t.t !== 'EOF'); }
  catch (e) { return { ok: false, text: `ERR: ${e.message}` }; }
  if (!toks.length || toks[0].t !== 'IDENT') {
    return { ok: false, text: 'ERR: a * command is a verb — try: *scan · *timer · *hack OB_XXXX · *echo "hi"' };
  }
  const verb = toks[0].v.toLowerCase();
  const builtins = makeBuiltins(ctx && ctx.station);
  const b = builtins[verb];
  if (!b) {
    if (ctx && ctx.station && ALL_VERBS.has(verb)) return { ok: false, text: `ERR: ${notHereMessage(toks[0].v, ctx.station)}` };
    return { ok: false, text: `ERR: no such command: ${toks[0].v}. type help for the list.` };
  }
  const out = [];
  OUT = out;   // so *echo prints through the same buffer as bare echo
  beginRun(ctx && ctx.fuel);
  const argVals = toks.slice(1).map(litTokenToValue);
  try {
    let v;
    if (argVals.length === 0) {
      v = b.arity === 0 ? b.fn([], ctx) : { tag: 'fn', name: verb, builtin: b, args: [], ctx };
    } else {
      let fn = { tag: 'fn', name: verb, builtin: b, args: [], ctx };
      for (const a of argVals) fn = applyValue(fn, a);
      v = fn;
    }
    if (v && v.tag === 'fn') return { ok: false, text: `ERR: ${USAGE_HINTS[verb] || `${verb} needs more arguments`}` };
    return { ok: true, text: combineOutput(out, v) };
  } catch (e) {
    if (e instanceof RonmlError) return { ok: false, text: `ERR: ${e.message}` };
    return { ok: false, text: `ERR: ${e.message || 'malformed command'}` };
  }
}

// The intents a program may choose between. The ENGINE knows how to do each of
// these already (robots.js); the program only picks. Anything else a program
// returns is a fault — a machine that asks for something it cannot do is broken,
// not creative.
export const INTENTS = ['patrol', 'hunt', 'flee', 'home', 'tend', 'wait'];

// What a program may say about its weapon, alongside what it says about its
// feet. A unit moves and shoots in the same quarter-second, so one intent per
// tick cannot describe it, which is why a program may return a pair.
export const FIRE = ['fire', 'hold', 'reload'];

// Run a machine's own program against a snapshot of its senses and get back the
// intent it chose. Pure: no world, no mutation, no clock. Returns
// {ok:true, intent} or {ok:false, fault} — and a fault is a fact about the
// machine, which the engine shows as a faulted unit rather than an error.
export function decide(program, sense, opts = {}) {
  const ctx = { station: 'robot', session: {}, sense, fuel: opts.fuel || 2000 };
  // A program is ONE expression, however many lines it is written across — an
  // if/else laid out over four lines is still a single expression, so the lines
  // are joined before evaluation. Locals come from `let … in …`, which is the
  // ML way and needs nothing added. (Comments are dropped first so a leading
  // (* … *) line cannot swallow the program.)
  const src = String(program || '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('(*'))
    .join(' ');
  if (!src) return { ok: false, fault: 'the program is empty' };
  // Effects (beep, eye, flash) are collected while the expression evaluates,
  // so only the branch actually taken has them — which is what makes them
  // useful for telling one machine from another at a distance.
  EFFECTS = [];
  const r = runRonml(src, ctx);
  const effects = EFFECTS;
  EFFECTS = null;
  if (!r.ok) return { ok: false, fault: r.text.replace(/^ERR: /, ''), effects };

  // A program returns either ONE intent, or a PAIR of what to do with its feet
  // and what to do with its weapon: `[hunt, fire]`. The pair exists because a
  // W-4 moves and shoots in the same tick and a single word cannot say that.
  const raw = String(r.text).trim();
  const pair = raw.match(/^\[\s*([a-z_]+)\s*,\s*([a-z_]+)\s*\]$/i);
  const intent = (pair ? pair[1] : raw).toLowerCase();
  const fire = pair ? pair[2].toLowerCase() : null;
  if (!INTENTS.includes(intent)) {
    return { ok: false, fault: `'${pair ? pair[1] : raw}' is not something this unit can do`, effects };
  }
  if (fire && !FIRE.includes(fire)) {
    return { ok: false, fault: `'${pair[2]}' is not something this unit can do with a weapon`, effects };
  }
  return { ok: true, intent, fire, effects };
}


// WHAT THIS BUILD DOES NOT HAVE, said in words.
//
// A file of Standard ML pasted in here will fail, and it should; the useful
// question is whether it fails in a way that tells you why. "unexpected
// character ':'" is a lexer complaining about the third token of a signature
// block, and it names neither the construct nor the reason. The console's
// stated job is to teach rather than gatekeep, and that has to hold when the
// answer is no.
//
// Pure, ordered most specific first, and returns null when nothing is
// recognised so the parser's own message stands.
const NOT_FITTED = [
  // A test walks this list and asserts every pattern here still FAILS to parse.
  // That is the only thing that has stopped it going stale: it went on refusing
  // modules, exceptions, chars, local and refs after each of them shipped, six
  // times, and every time it fired before the parser and hid the real error.
  // `infix`/`infixr`/`nonfix`/`op` were here until v1.277 added them, and
  // String/List/Int/Option were here until v1.257 added them. Both pruned by
  // the test below, which is the only thing that has ever kept this honest.
  [/\b(Word|Array|Vector|IO|TextIO|OS|Math|Substring|General)\./, 'that library is not on this machine. ml -full lists what is.'],
  [/^\s*(abstype|open)\b/, 'no abstype and no open on this build.'],
];

// The samples the test uses, one per rule above, in the same order.
// One sample per rule in NOT_FITTED, walked by a test that checks each is
// still genuinely refused. `Char.ord c` left this list at v1.285, when the
// prelude gained Char and Real; `Array.sub` replaces it as a structure that
// really is absent.
export const NOT_FITTED_SAMPLES = ['Array.sub (a, 0)', 'open List'];

export function diagnose(src) {
  for (const [re, why] of NOT_FITTED) if (re.test(src)) return why;
  return null;
}

// Split a program file into the logical lines the parser expects, KEEPING the
// physical line each one started on, so an error can say where. See
// joinProgramLines for the joining rules; this is the same function with the
// numbers left in.

// What the type checker makes of a line, as a string to print beside the
// answer. Never throws and never refuses: inference here REPORTS. A machine in
// a name it has never seen is "anything" rather than an error.
// THE LIBRARY, written in the language it is for.
//
// It is loaded as source rather than built as JavaScript builtins, so `List.map`
// is the same map a player would write and can be read with the same eyes. The
// structures are the ones the manuals name, minus everything this build has no
// way to do.
export const PRELUDE = [
  "datatype 'a option = NONE | SOME of 'a",
  'datatype order = LESS | EQUAL | GREATER',
  '',
  '(* Composition and sequencing. Standard ML has these infix in the top-level',
  '   environment, so the fixity is declared here rather than seeded into the',
  '   parser: fixity is a fact about a program, and a program that wants `o`',
  '   for something else can say `nonfix o` and have it. *)',
  'fun o (f, g) = fn x => f (g x)',
  'infixr 3 o',
  'fun before (a, b) = a',
  'infix 0 before',
  'fun ignore _ = ()',
  '',
  'structure List = struct',
  '  fun null nil = true | null _ = false',
  '  fun map f nil = nil | map f (h :: t) = f h :: map f t',
  '  fun filter p nil = nil',
  '    | filter p (h :: t) = if p h then h :: filter p t else filter p t',
  '  fun foldl f b nil = b | foldl f b (h :: t) = foldl f (f h b) t',
  '  fun foldr f b nil = b | foldr f b (h :: t) = f h (foldr f b t)',
  '  fun rev l = foldl (fn h => fn a => h :: a) nil l',
  '  fun exists p nil = false | exists p (h :: t) = p h orelse exists p t',
  '  fun all p nil = true | all p (h :: t) = p h andalso all p t',
  '  fun find p nil = NONE',
  '    | find p (h :: t) = if p h then SOME h else find p t',
  '  fun app f nil = () | app f (h :: t) = (f h; app f t)',
  '  fun last (h :: nil) = h | last (h :: t) = last t',
  '  fun nth (h :: t, n) = if n = 0 then h else nth (t, n - 1)',
  '  fun take (l, n) = if n = 0 then nil else hd l :: take (tl l, n - 1)',
  '  fun drop (l, n) = if n = 0 then l else drop (tl l, n - 1)',
  '  fun concat nil = nil | concat (h :: t) = h @ concat t',
  '  fun tabulate (n, f) = if n = 0 then nil else tabulate (n - 1, f) @ [f (n - 1)]',
  '  (* partition returns the pair (kept, rejected), in the original order. *)',
  '  fun partition p nil = (nil, nil)',
  '    | partition p (h :: t) =',
  '        let val (y, n) = partition p t',
  '        in if p h then (h :: y, n) else (y, h :: n) end',
  '  (* zip stops at the shorter list, as ListPair.zip does. *)',
  '  fun zip (nil, _) = nil',
  '    | zip (_, nil) = nil',
  '    | zip (a :: as1, b :: bs) = (a, b) :: zip (as1, bs)',
  '  fun unzip nil = (nil, nil)',
  '    | unzip ((a, b) :: t) = let val (x, y) = unzip t in (a :: x, b :: y) end',
  'end',
  '',
  'structure ListPair = struct',
  '  val zip = List.zip',
  '  val unzip = List.unzip',
  'end',
  '',
  'structure Char = struct',
  '  fun isDigit c = ord c >= 48 andalso ord c <= 57',
  '  fun isUpper c = ord c >= 65 andalso ord c <= 90',
  '  fun isLower c = ord c >= 97 andalso ord c <= 122',
  '  fun isAlpha c = isUpper c orelse isLower c',
  '  fun isAlphaNum c = isAlpha c orelse isDigit c',
  '  fun isSpace c = ord c = 32 orelse ord c = 9 orelse ord c = 10',
  '  fun toUpper c = if isLower c then chr (ord c - 32) else c',
  '  fun toLower c = if isUpper c then chr (ord c + 32) else c',
  '  fun toString c = "" ^ c',
  '  fun compare (a, b) = Int.compare (ord a, ord b)',
  'end',
  '',
  'structure String = struct',
  '  fun size s = length (explode s)',
  '  fun sub (s, n) = List.nth (explode s, n)',
  '  fun map f s = implode (List.map f (explode s))',
  '  fun rev s = implode (List.rev (explode s))',
  '  fun concat nil = "" | concat (h :: t) = h ^ concat t',
  '  fun isPrefix (p, s) = List.take (explode s, size p) = explode p',
  '  fun substring (s, i, n) = implode (List.take (List.drop (explode s, i), n))',
  '  fun extract (s, i, NONE) = implode (List.drop (explode s, i))',
  '    | extract (s, i, SOME n) = substring (s, i, n)',
  '  (* translate maps each character to a STRING and joins the results, which',
  '     is what lets it delete and expand as well as replace. *)',
  '  fun translate f s = concat (List.map f (explode s))',
  '  fun concatWith sep nil = ""',
  '    | concatWith sep (h :: nil) = h',
  '    | concatWith sep (h :: t) = h ^ sep ^ concatWith sep t',
  '  (* tokens splits on every character the predicate accepts and DROPS empty',
  '     fields; fields keeps them. That is the only difference between them. *)',
  '  fun fields p s =',
  '        let fun go (nil, cur) = [implode (List.rev cur)]',
  '              | go (c :: t, cur) =',
  '                  if p c then implode (List.rev cur) :: go (t, nil)',
  '                  else go (t, c :: cur)',
  '        in go (explode s, nil) end',
  '  fun tokens p s = List.filter (fn f => f <> "") (fields p s)',
  '  fun toString s = s',
  '  val explode = explode',
  '  val implode = implode',
  '  (* compare walks the two strings together and answers at the first',
  '     character that differs; a prefix is LESS than what extends it. *)',
  '  fun compare (a, b) =',
  '        let fun go (nil, nil) = EQUAL',
  '              | go (nil, _) = LESS',
  '              | go (_, nil) = GREATER',
  '              | go (x :: xs, y :: ys) =',
  '                  case Char.compare (x, y) of',
  '                    EQUAL => go (xs, ys)',
  '                  | r => r',
  '        in go (explode a, explode b) end',
  'end',
  '',
  'structure Int = struct',
  '  fun abs n = if n < 0 then 0 - n else n',
  '  fun min (a, b) = if a < b then a else b',
  '  fun max (a, b) = if a > b then a else b',
  '  fun toString n = "" ^ n',
  '  fun compare (a, b) = if a < b then LESS else if a > b then GREATER else EQUAL',
  '  fun sign n = if n < 0 then ~1 else if n > 0 then 1 else 0',
  '  (* fromString answers an option: a string that is not a numeral is not an',
  '     error, it is simply NONE, and the caller decides what that means. *)',
  '  fun fromString s =',
  '        let fun digits (nil, acc, seen) = if seen then SOME acc else NONE',
  '              | digits (c :: t, acc, seen) =',
  '                  if Char.isDigit c then digits (t, acc * 10 + (ord c - 48), true)',
  '                  else NONE',
  '        in case explode s of',
  '             nil => NONE',
  '           | #"~" :: t => (case digits (t, 0, false) of',
  '                             SOME n => SOME (0 - n)',
  '                           | NONE => NONE)',
  '           | cs => digits (cs, 0, false)',
  '        end',
  'end',
  '',
  'structure Real = struct',
  '  fun abs x = if x < 0.0 then 0.0 - x else x',
  '  fun min (a, b) = if a < b then a else b',
  '  fun max (a, b) = if a > b then a else b',
  '  fun fromInt n = real n',
  '  fun round x = floor (x + 0.5)',
  '  fun toString x = "" ^ x',
  'end',
  '',
  'structure Bool = struct',
  '  fun toString true = "true" | toString false = "false"',
  '  fun fromString "true" = SOME true',
  '    | fromString "false" = SOME false',
  '    | fromString _ = NONE',
  '  fun not true = false | not false = true',
  'end',
  '',
  'structure Option = struct',
  '  fun isSome NONE = false | isSome (SOME _) = true',
  '  fun valOf (SOME x) = x',
  '  fun getOpt (NONE, d) = d | getOpt (SOME x, _) = x',
  '  fun map f NONE = NONE | map f (SOME x) = SOME (f x)',
  '  fun join NONE = NONE | join (SOME x) = x',
  '  fun filter p x = if p x then SOME x else NONE',
  'end',
].join('\n');

// Load it into a session. Cheap enough to do on the first line typed, and
// skipped afterwards.
export function loadPrelude(ctx) {
  const sess = (ctx && ctx.session) || {};
  if (sess.__prelude) return;
  sess.__prelude = true;
  for (const line of joinProgramLines(PRELUDE)) {
    try { runRonml(line, ctx); } catch { /* a prelude line that fails is a bug, not a player error */ }
  }
}

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

export function typeReport(source, ctx) {
  if (!ctx || !ctx.types) return null;
  try {
    // Parse with the SESSION's fixity, exactly as the evaluator does below.
    // Reading the line a second time with a different table is how the checker
    // came to reject `2 plus 3` after `infix 6 plus`: it saw an application of
    // 2 to two arguments, which is ill-typed, while the evaluator saw the
    // operator the user had just declared. Same text, two grammars.
    const ast = parseLine(source, (ctx.session && ctx.session.__fixity) || undefined);
    const r = typeOf(ast, ctx.session || {});
    if (!r.ok) return r.error ? `TYPE: ${r.error}` : null;
    remember(ast, ctx.session || {}, r.t);
    // A warning rides alongside the type rather than replacing it: the line is
    // well typed and also has a hole in it, and you want to be told both.
    if (r.warnings && r.warnings.length) return `${r.type}    WARNING: ${r.warnings.join('; ')}`;
    return r.type;
  } catch {
    return null;         // unparseable is the parser's business, not this one's
  }
}

// ---- what this build of the language is ------------------------------------
//
// The language has its own version now, separate from the game's. It grew by
// accretion for two hundred versions and then by measurement against somebody
// else's corpus, and a reader who pastes a program in deserves to know which
// build refused it. `ml -ver` prints the line; `ml -full` prints the survey.
export const AIML_VERSION = '2.5';
export const AIML_NAME = 'AI-ML';

// THE CREDIT. One list, printed by -ver and again at the foot of -full, so the
// two can never drift apart. Also shown in the game's About box.
export const AIML_CREDIT = [
  'AI-ML created by David M. Berry, 2026.',
  'Based on Standard ML developed by Robin Milner, Mads Tofte, and',
  'Robert Harper. Many thanks to Robert Harper for the inspiration in',
  'his book "Introduction to Standard ML" (1986), and to \u00c5ke Wikstr\u00f6m for',
  '"Functional Programming Using Standard ML" (1987).',
];

export function aimlVersion() {
  return [
    `${AIML_NAME} ${AIML_VERSION}  (BML stack)`,
    'A descendant of Standard ML. Type inference, modules, exceptions.',
    'ml -full  for full details about this implementation.',
    '',
    ...AIML_CREDIT,
  ].join('\n');
}

// The survey: what is here, what is not, and what is here but spelled
// differently. Enough to tell whether a given program will run.
export function aimlFull() {
  const L = [];
  const sec = (t) => { L.push('', t, '='.repeat(t.length)); };
  const row = (a, b) => L.push(`  ${a.padEnd(26)}${b}`);

  L.push(`${AIML_NAME} ${AIML_VERSION}  (BML stack)`);
  L.push('The language on the obelisk consoles, the HERMES relays, this laptop,');
  L.push('and inside every machine that runs a program you can read.');

  sec('VALUES');
  row('int', '4, ~3. div and mod are whole-number.');
  row('real', '3.5, 2.0. / divides these and not ints.');
  row('', 'real n and floor x go between them.');
  row('char', '#"a". ord chr str explode implode.');
  row('str', '"a string". ^ joins two.');
  row('bool', 'true false. and or not, andalso orelse.');
  row('unit', '()');
  row('tuple', '(1, "a"). Fixed width, mixed kinds.');
  row('record', '{ a = 1, b = 2 }. #a selects. #1 works on a tuple.');
  row('list', 'nil, ::, [1,2,3], @ joins. hd tl length.');
  row('ref', 'ref 0, !r reads, r := v writes. The only mutable thing.');

  sec('BINDING AND FUNCTIONS');
  row('let / val / fun', 'three words, one thing.');
  row('let ... in ... end', 'several bindings, and joins them.');
  row('fn x => e', 'lambda. fn takes alternatives too.');
  row('let f x y = e', 'curried. Partial application gives a function.');
  row('clausal definitions', 'fun f nil = 0 | f (h::t) = 1 + f t');
  row('pattern bindings', 'let (m, n) = e, and in parameters.');
  row('recursion', 'a name is in scope inside its own value.');

  sec('TAKING THINGS APART');
  row('case e of p => e', 'first arm that fits wins.');
  row('patterns', 'constructor, variable, _, constant, nil, ::,');
  L.push('                            tuple, record, { ... }, as.');
  row('datatype', "datatype 'a option = NONE | SOME of 'a");

  sec('THE LARGER STRUCTURES');
  row('structure / struct', 'publishes its names under a prefix: Board.size');
  row('signature / sig', 'names what a structure shows.');
  row(':>  opaque ascription', 'hides everything the signature omits.');
  row('exception / raise', 'exception Fail; raise Fail');
  row('handle', 'e handle Fail => e, with full pattern arms.');
  row('type', 'type board = int * int. An abbreviation.');
  row('local ... in ... end', 'declarations in scope for the block only.');
  row('functor F (X) = ...', 'a structure taking a structure. F (A) applies it.');

  sec('TYPES');
  row('inference', 'Hindley-Milner. Runs on this laptop only.');
  row('', 'map : (\'a -> \'b) -> \'a list -> \'b list');
  row('annotations', 'val x : int = 5. Checked, not decoration.');
  row('on a clash', 'names it, then runs the line anyway.');

  sec('THE LIBRARY');
  row('List', 'map filter foldl foldr rev exists all find app');
  L.push('                            last nth take drop concat tabulate null');
  L.push('                            partition zip unzip');
  row('String', 'size sub map rev concat isPrefix substring extract');
  L.push('                            translate concatWith fields tokens compare');
  L.push('                            explode implode toString');
  row('Char', 'isDigit isAlpha isAlphaNum isUpper isLower isSpace');
  L.push('                            toUpper toLower toString compare');
  row('Int', 'abs min max sign toString fromString compare');
  row('Real', 'abs min max round fromInt toString');
  row('Bool', 'toString fromString not');
  row('Option', "datatype 'a option, isSome valOf getOpt map join filter");
  row('ListPair', 'zip unzip');
  row('order', 'datatype order = LESS | EQUAL | GREATER');
  row('top level', 'o (composition, infixr 3), before (infix 0), ignore');
  row('bare verbs', 'hd tl length abs sqrt min max size real floor');
  L.push('                            ord chr str explode implode ref echo');
  L.push('');
  L.push('  It is written in AI-ML, not underneath it. `ml -src List` prints it.');

  sec('NOT ON THIS BUILD');
  row('the rest of the library', 'no Array, Vector, IO, Math, Word, Substring.');

  sec('WRITTEN DIFFERENTLY');
  row('==  and  =', 'both are equality. A binding eats its = first.');
  row('(* comments *)', 'as in ML.');
  row('echo', 'prints. ; sequences.');
  row('|>', 'pipes a value into a function.');

  sec('WHERE IT RUNS');
  row('obelisk console', 'the tower verbs, and the language.');
  row('HERMES relay', "RON's own, plus the forge.");
  row('this laptop', 'the language alone, and the type checker.');
  row('inside a machine', 'its own program, 2,000 steps, four times a second.');
  L.push('');
  L.push('  A machine answers with an intent, or a pair: [hunt, fire].');
  L.push('  feet: patrol hunt flee home tend wait   weapon: fire hold reload');
  L.push('  senses: charge integrity range home_range threat hurt linked');
  L.push('          blight daylight sight armed shielded contact lost_for');
  L.push('');
  sec('WHAT THE CHECKER DOES');
  L.push('  Hindley-Milner inference: unification, occurs check, let-polymorphism,');
  L.push('  and the value restriction (an application does not generalise).');
  L.push('  Two modes. HERE it reports and does not refuse: a clash names itself');
  L.push('  and the line still runs, because a machine in a ruin should say what');
  L.push('  it worked out and let you decide. Strict mode, which the language has');
  L.push('  outside this game, refuses a line that does not typecheck — which is');
  L.push('  what makes it an ML. A `case` that misses a constructor is a WARNING');
  L.push('  under both, as it is in Standard ML.');
  L.push('  Equality is structural on records and lists, by identity on refs,');
  L.push('  and refused on functions.');
  L.push('');
  L.push('  On THIS machine only: `units` is what the wireless card can hear —');
  L.push('  a list of records with name, range, bearing and kind. See sniffer.ml.');
  sec('CREDITS');
  for (const l of AIML_CREDIT) L.push(`  ${l}`);

  return L.join('\n');
}



export function runRonml(source, ctx) {
  // `help` is a console meta-command, not a language expression — intercept it
  // before evaluation so a bare `help` prints the reference instead of failing
  // as an unknown name. `help <verb>` gives detail on one verb. (`notes` is a
  // real builtin now — see makeBuiltins — since it opens a UI overlay rather
  // than printing text.)
  const trimmed = source.trim();
  if (trimmed === 'help' || trimmed.startsWith('help ')) {
    return { ok: true, text: helpText(trimmed.slice(4).trim(), ctx && ctx.station, ctx && ctx.hasManual) };
  }
  // `*command` — the BBC-Micro command form, run with literal arguments. Anything
  // without a leading `*` is an AI-ML expression (let / pipes / values / lambdas).
  if (trimmed.startsWith('*')) return runStar(trimmed.slice(1), ctx);
  try {
    // STRICT MODE. In Standard ML a program that does not typecheck does not
    // run — that is the whole point of the type system, and until this existed
    // the honest claim was that AI-ML *infers* types, not that it *is* typed.
    //
    // The game stays advisory everywhere (`report`): a machine in a ruin should
    // say what it worked out and let the operator decide, and a T-1 has neither
    // a checker nor anyone to read it. `strict` is for the standalone REPL.
    // Same checker, same message; the only difference is whether the line then
    // runs. Warnings (exhaustiveness) stay warnings under both.
    if (ctx && ctx.typecheck === 'strict') {
      const ty = typeReport(source, { ...ctx, types: true });
      if (ty && ty.startsWith('TYPE:')) {
        return { ok: false, text: `ERR: ${ty.slice(6).trim()}` };
      }
    }
    const toks = tokenize(source);
    // Nothing but comments and space is EMPTY INPUT, not a broken command. The
    // parser reported `unexpected end of command` for a line holding only a
    // `(* … *)`, so pasting a commented program produced one error per comment.
    // In Standard ML a comment is whitespace.
    if (!toks.length || (toks.length === 1 && toks[0].t === 'EOF')) return { ok: true, text: '' };
    // The session's fixity table, so `infix 8 OR` on an earlier line changes how
    // this one reads.
    const ast = parse(toks, (ctx && ctx.session && ctx.session.__fixity) || undefined);
    const builtins = makeBuiltins(ctx && ctx.station);
    // A bare word typed as a WHOLE command that is neither a verb nor a known
    // binding is a typo, not a value — say so (and let the error chime play),
    // instead of echoing it back with the success chime as if it ran. This fires
    // ONLY at the top level: arguments (aikey, map, OB_XXXX, filenames) still
    // evaluate to atoms exactly as before.
    // A plain word (no hyphen, no dot) is command-shaped; a hyphenated node code
    // (OB_XXXX) or a dotted filename (foo.ml) is a legitimate bare VALUE and is
    // left alone.
    // ...but NOT in a machine's own program, where a bare word is the intent it
    // chose (`patrol`), not a mistyped command.
    if (ast && ast.type === 'Var' && /^[a-z][a-z0-9]*$/i.test(ast.name)
        && !(ctx && ctx.station === 'robot')) {
      const lower = ast.name.toLowerCase();
      const bound = Object.prototype.hasOwnProperty.call((ctx && ctx.session) || {}, lower);
      const declared = (ctx && ctx.session && ctx.session.__cons) || {};
      const isCon = Object.prototype.hasOwnProperty.call(declared, ast.name);
      if (!bound && !isCon && !builtins[lower] && lower !== 'true' && lower !== 'false' && lower !== 'nil') {
        if (ctx && ctx.station && ALL_VERBS.has(lower)) {
          return { ok: false, text: `ERR: ${notHereMessage(ast.name, ctx.station)}` };
        }
        return { ok: false, text: `ERR: no such command: ${ast.name}. type help for the list.` };
      }
    }
    // Fresh output buffer for this line: `echo` pushes into it mid-evaluation, so a
    // `;`-sequence or a recursive echo prints every step, not just the final value.
    const out = [];
    OUT = out;
    beginRun(ctx && ctx.fuel);
    // Base env is the persistent session (main.js passes ctx.session) so bare
    // top-level `let`/`copy` bindings survive to the next line entered.
    const result = evalNode(ast, (ctx && ctx.session) || {}, ctx, builtins);
    if (result && result.tag === 'fn') {
      return { ok: false, text: `ERR: ${USAGE_HINTS[result.name] || `${result.name} needs more arguments`}` };
    }
    return { ok: true, text: combineOutput(out, result) };
  } catch (e) {
    // If the line is a piece of Standard ML this build does not have, say
    // which piece. The parser's own message names the character it choked
    // on, which for a signature block is a colon, and that helps nobody.
    if (e instanceof RonmlRaise) {
      return { ok: false, text: `ERR: uncaught exception ${formatValue(e.value)}` };
    }
    // A JavaScript stack overflow means one thing here: a program that recursed
    // without ever coming back. The step budget is supposed to catch that first,
    // but the two are in a race — a deeply nested (non-tail) recursion uses
    // several host frames per AI-ML step, so on a small stack the host loses.
    // Report it as what it is rather than leaking the engine's own words, and
    // the fault a machine shows is the same either way.
    if (e instanceof RangeError && /call stack/i.test(e.message || '')) {
      return { ok: false, text: 'ERR: step budget exceeded — this recursion never comes back' };
    }
    const why = diagnose(source);
    if (why) return { ok: false, text: `ERR: ${why}` };
    if (e instanceof RonmlError) return { ok: false, text: `ERR: ${e.message}` };
    return { ok: false, text: `ERR: ${e.message || 'malformed command'}` };
  }
}
