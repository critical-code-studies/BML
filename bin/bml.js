#!/usr/bin/env node
//
// BML — a 2026 Standard ML. The read-eval-print loop.
//
//   node bin/bml.js              strict: a line that does not typecheck is refused
//   node bin/bml.js --sloppy     advisory: a clash is named and the line still runs
//   node bin/bml.js file.ml …    run files, then exit (add -i to stay at the prompt)
//
// BML created by David M. Berry, 2026. Based on Standard ML developed by
// Robin Milner, Mads Tofte, and Robert Harper. Many thanks to Robert Harper for
// the inspiration in his book "Introduction to Standard ML" (1986), and to Åke
// Wikström for "Functional Programming Using Standard ML" (1987).
//
// This file imports src/ and nothing else: no game, no stations, no verbs.
// It builds one interpreter through the same `createInterpreter` NostOS uses,
// and differs from the game only in what it passes — strict rather than
// advisory, and no host hooks at all. The game is advisory everywhere because a
// machine in a ruin should say what it worked out and let the operator decide.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createInterpreter, smlEcho, joinProgram, needsMoreInput, continuesPrevious,
  readlineCompleter, BML_NAME, BML_VERSION, BML_CREDIT,
} from '../src/index.js';

// A closed pipe is not an error. `bml | head -1` shuts stdout while readline is
// still writing a prompt into it, and node turns that into an unhandled EPIPE
// and a stack trace. Every unix tool that writes to a pipe has to do this.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });

const argv = process.argv.slice(2);
const sloppy = argv.includes('--sloppy');
const forceRepl = argv.includes('-i');
const files = argv.filter((a) => !a.startsWith('-'));

// ---- Is there a newer one? --------------------------------------------------
//
// WHAT THIS DOES AND DOES NOT DO, because a tool that quietly contacts a server
// is the opposite of the thing this repository argues for.
//
// It fetches one file, package.json, from the public repository, and compares
// its version to this one. It sends no identity, no telemetry and no arguments;
// what a web server can infer is that some IP asked for a public file, which is
// true of reading the README.
//
// It runs ONLY in an interactive session: not for `bml file.ml`, not in a
// pipe, not in CI, not under a test. It caches for a day, times out after a
// second and a half, and fails silently, so it can never delay or break a
// session. `BML_NO_UPDATE_CHECK=1` turns it off entirely.
const VERSION_URL = 'https://raw.githubusercontent.com/critical-code-studies/BML/main/package.json';
// The cache path is overridable, and the tests override it. They used to write
// the REAL one: a test planted a cache claiming 99.0.0 was out, to prove a
// piped session stays quiet, and every later interactive session read it and
// announced an update that did not exist. Test fixtures must not be able to
// reach into the thing they are testing.
// THE STEP BUDGET AT A PROMPT. Every run counts steps so a program that never
// comes back faults instead of hanging. The default is the GAME's, 200,000,
// picked so a machine's program cannot stall a render loop — and a command line
// has no render loop, so a REPL inherited a constraint it does not have. It
// stopped `sum (20000, 0)` in the same release that gave the language proper
// tail calls.
//
// 50 million: a runaway faults in about a second, and `sum (1000000, 0)` runs.
const REPL_FUEL = 50000000;

const CACHE = process.env.BML_VERSION_CACHE || path.join(os.tmpdir(), 'bml-version-check.json');
const DAY = 24 * 60 * 60 * 1000;

function cached() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c && typeof c.at === 'number' && Date.now() - c.at < DAY
        && /^\d+\.\d+\.\d+$/.test(String(c.latest || ''))) return c.latest;
  } catch { /* no cache, or unreadable: check again */ }
  return null;
}

// "0.10.0" is newer than "0.9.0", which a string comparison gets wrong.
function isNewer(latest, mine) {
  const a = String(latest).split('.').map(Number);
  const b = String(mine).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdate() {
  if (process.env.BML_NO_UPDATE_CHECK) return null;
  if (!process.stdin.isTTY) return null;          // scripts, pipes, CI, tests
  const hit = cached();
  if (hit !== null) return isNewer(hit, BML_VERSION) ? hit : null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(VERSION_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const latest = String((await res.json()).version || '');
    try { fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), latest })); } catch { /* cache is a nicety */ }
    return isNewer(latest, BML_VERSION) ? latest : null;
  } catch {
    return null;    // offline, blocked, slow, moved: none of it is your problem
  }
}

// `bml --examples [dir]` copies the example programs somewhere you can edit
// them. Installed, they live inside node_modules where nobody will find them
// and nobody should be editing them in place.
//
// A copy on request rather than a postinstall hook: npm's postinstall is
// disabled in plenty of setups, it runs without being asked, and writing to
// somebody's working directory because they installed a package is not on.
if (argv.includes('--examples')) {
  const from = new URL('../examples/', import.meta.url).pathname;
  const rest = argv.filter((a) => !a.startsWith('-'));
  const to = path.resolve(rest[0] || 'bml-examples');
  if (!fs.existsSync(from)) {
    console.log('This copy has no examples/ directory next to it.');
    process.exit(1);
  }
  if (fs.existsSync(to)) {
    console.log(`${to} already exists. Move it, or name somewhere else:`);
    console.log('  bml --examples somewhere-else');
    process.exit(1);
  }
  fs.mkdirSync(to, { recursive: true });
  const names = fs.readdirSync(from).sort();
  for (const n of names) fs.copyFileSync(path.join(from, n), path.join(to, n));
  console.log(`Copied ${names.length} files to ${to}`);
  console.log('');
  for (const n of names.filter((x) => x.endsWith('.ml'))) console.log(`  bml ${path.join(path.basename(to), n)}`);
  console.log('');
  console.log('Start with the first. They are meant to be edited and rerun.');
  process.exit(0);
}

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(`${BML_NAME} ${BML_VERSION}`);
  // Explicit, so it checks even when the automatic one would not, and says so
  // either way rather than leaving you wondering whether it looked.
  if (process.env.BML_NO_UPDATE_CHECK) {
    console.log('(update check off: BML_NO_UPDATE_CHECK is set)');
  } else {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(VERSION_URL, { signal: ctl.signal });
      clearTimeout(timer);
      const latest = String((await res.json()).version || '');
      if (isNewer(latest, BML_VERSION)) console.log(`${latest} is available: npm install github:critical-code-studies/BML`);
      else console.log('up to date');
    } catch { console.log('(could not reach github to check for a newer one)'); }
  }
  process.exit(0);
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    `${BML_NAME} ${BML_VERSION}, a 2026 Standard ML`,
    'Created by David M. Berry, University of Sussex, 2026.',
    '',
    '  bml                 strict repl (ill-typed lines are refused)',
    '  bml --sloppy        advisory repl (a clash is named; the line runs)',
    '  bml file.ml …       run files and exit',
    '  bml -i file.ml      run files, then stay at the prompt',
    '  bml --examples      copy the example programs here, to edit and run',
    '  bml --version       which build this is, and whether a newer one exists',
    '',
    'At the prompt:',
    '  use "file.ml";      read a file in',
    '  :t <expr>           show a type without evaluating',
    '  :quit               leave (or ^D)',
    '',
    ...BML_CREDIT.map((l) => `  ${l}`),
  ].join('\n'));
  process.exit(0);
}

// One interpreter for the whole run: bindings, fixity and datatypes persist
// from line to line, as they do at any ML top level. No station, no verbs, no
// host hooks — this is the language with nothing else attached, which is the
// point of the file.
// The clock is a host policy — the language asks, it does not reach — and a
// command line is a machine with a real one.
const bml = createInterpreter({
  typecheck: sloppy ? 'report' : 'strict',
  clock: () => Date.now(),
});
bml.loadPrelude();


// What the REPL says when it opens. Who made it, where, and which build, so a
// screenshot of a session carries its own provenance.
function banner() {
  return [
    '',
    '------------------------------------------------------------',
    `${BML_NAME} ${BML_VERSION}, a 2026 Standard ML${sloppy ? '  (advisory)' : ''}`,
    'Created by David M. Berry, University of Sussex, 2026.',
    'Based on Standard ML developed by Robin Milner, Mads Tofte and Robert Harper.',
    '',
    // BOTH LINES DESCRIBE THE MODE. This one read `strict: use typecheck`,
    // which looks like an instruction to type `typecheck` — and that is not a
    // command, so it answered `unbound variable: typecheck`. The advisory line
    // beside it was already a description; they match now.
    sloppy
      ? 'advisory: a clash is named and the line runs anyway.'
      : 'strict: a line that does not typecheck is refused. --sloppy runs it anyway.',
    'Type help for more info, :quit to leave.',
    '------------------------------------------------------------',
    '',
  ].join('\n');
}

// `help` at the prompt. It is not a language expression and never was: in the
// game the console intercepts it before evaluation, and that interception lives
// in the game's adapter, so out here `help` was an unbound variable. A REPL that
// cannot tell you what it takes is not much of a teaching interpreter.
const HELP = `${BML_NAME} ${BML_VERSION}, a 2026 Standard ML
Created by David M. Berry, University of Sussex, 2026.

DECLARATIONS
  val x = 5                       bind a value
  val (a, b) = (1, 2)             bind through a pattern
  fun f x = x + 1                 a function
  fun fact 0 = 1                  clauses, tried in order
    | fact n = n * fact (n - 1)
  datatype t = A | B of int       a type of your own
  type point = int * int          an abbreviation
  exception Bad                   an exception
  infix 6 plus                    give a name a fixity
  structure S = struct ... end    a module
  signature S = sig ... end       what a module shows
  functor F (X : S) = struct ...  a module taking a module

EXPRESSIONS
  fn x => x + 1                   a function with no name
  if p then a else b
  case e of A => 1 | B n => n     take a value apart
  let val x = 1 in x + 1 end      a binding with a scope
  e handle Bad => 0               catch what was raised
  raise Bad
  a andalso b   a orelse b        short-circuit

VALUES
  1   1.5   #"a"   "hi"   true   ()
  (1, "a")        a tuple
  {x = 1, y = 2}  a record, taken apart with #x
  [1, 2, 3]       a list, built from nil and ::
  ref 0  !r  r := 1               the one mutable thing

THE LIBRARY, written in BML and loaded as source
  List String Char Int Real Bool Option ListPair
  hd tl length explode implode ord chr size abs o before ignore
  Open src/basis.js and read it: the map you call is the map you could write.

AT THE PROMPT
  :t <expr>       show a type without evaluating it
  use "f.ml";     read a file in
  help            this
  :quit           leave (or ^D)`;

// Run one line and print what Standard ML would print. Returns false if the
// line was refused, so a file can stop at its first error rather than pressing
// on with half a program loaded.
function step(src) {
  const line = String(src).trim();
  if (!line) return true;
  if (line === ':quit' || line === ':q') return null;
  // Anything beginning with `help` is the same request: `help date` reached the
  // interpreter and came back as "unbound variable: help", which helps nobody.
  if (/^(help\b|:help$|\?$)/.test(line)) { console.log(HELP); return true; }
  if (line.startsWith(':t ')) {
    const t = bml.typeReport(line.slice(3));
    console.log(t || 'no type: the checker could not read that');
    return true;
  }
  // `use "file.ml";` — SML's own way of reading a file at the top level.
  const use = line.match(/^use\s+"([^"]+)"\s*;?$/);
  if (use) return runFile(use[1]);

  const ty = bml.typeReport(line);
  const r = bml.run(line, { fuel: REPL_FUEL });
  if (!r.ok) { console.log(r.text); return false; }
  for (const out of smlEcho(r.text, ty)) console.log(out);
  return true;
}

function runFile(path) {
  let text;
  try { text = fs.readFileSync(path, 'utf8'); }
  catch { console.log(`ERR: cannot read ${path}`); return false; }
  // A file is a run of declarations, not one expression: joinProgram puts each
  // back together across the lines it was written on.
  for (const l of joinProgram(text)) {
    const one = String(l && l.text !== undefined ? l.text : l);
    if (step(one) === false) { console.log(`ERR: stopped in ${path}`); return false; }
  }
  return true;
}

let failed = false;
for (const f of files) { if (!runFile(f)) failed = true; }
if (files.length && !forceRepl) process.exit(failed ? 1 : 0);

console.log(banner());

// Interactive only, cached, silent on failure. See checkForUpdate above.
const newer = await checkForUpdate();
if (newer) {
  console.log(`  A newer BML is out: ${newer} (you have ${BML_VERSION}).`);
  console.log('  npm install github:critical-code-studies/BML');
  console.log('');
}

// TAB COMPLETES. The rule is in the language (src/lang/complete.js) so that the
// page's prompt and this one cannot drift apart, and so it can be tested
// without a terminal.
//
// Against the CURRENT PHYSICAL LINE, not the held continuation text: mid
// declaration the buffer holds `fun fact 0 = 1` from the line before, and
// completing against that would offer names for a word the reader is not
// typing and replace the wrong span. readline hands us the line it is editing,
// which is the right one.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '- ',
  completer: (line) => readlineCompleter(line, bml),
});
rl.prompt();

// A DECLARATION MAY RUN OVER TWO LINES, and until 0.38.0 this loop took one
// physical line and no more, so `fun fact 0 = 1` followed by `| fact n = …`
// answered *unexpected 'BAR'* — while the README printed a transcript showing
// the `=` continuation prompt, which had never existed.
//
// Forwards: text that cannot have ended is held. Backwards: a line that cannot
// have STARTED anything belongs to the declaration above, which has already
// run, so it runs again with the clause attached. Rebinding is what a top level
// does anyway.
let pending = '';
let last = '';
rl.on('line', (line) => {
  const typed = String(line);
  // LEAVING ALWAYS WORKS, held line or not. Buffering it would trap anyone who
  // opened a bracket and then thought better of the whole thing, and a prompt
  // you cannot leave is not a prompt.
  if (/^\s*:(quit|q)\s*$/.test(typed)) { rl.close(); return; }
  // A BLANK LINE ABANDONS what is held. This is the way out of a stray `(`,
  // which is unfinished by every test there is and would otherwise take the
  // rest of the session with it.
  if (pending && !typed.trim()) {
    console.log('(abandoned)');
    pending = '';
    rl.setPrompt('- ');
    rl.prompt();
    return;
  }
  let source = typed.trim();
  if (pending) source = `${pending} ${source}`;
  else if (continuesPrevious(typed) && last) source = `${last} ${source}`;
  if (source && needsMoreInput(source)) {
    pending = source;
    rl.setPrompt('=   ');
    rl.prompt();
    return;
  }
  pending = '';
  rl.setPrompt('- ');
  if (step(source) === null) { rl.close(); return; }
  last = source;
  rl.prompt();
});
rl.on('close', () => { console.log(''); process.exit(0); });
