#!/usr/bin/env node
//
// BML — a little Standard ML. The read-eval-print loop.
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
import {
  createInterpreter, smlEcho, joinProgram,
  BML_NAME, BML_VERSION, BML_CREDIT,
} from '../src/index.js';

// A closed pipe is not an error. `bml | head -1` shuts stdout while readline is
// still writing a prompt into it, and node turns that into an unhandled EPIPE
// and a stack trace. Every unix tool that writes to a pipe has to do this.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });

const argv = process.argv.slice(2);
const sloppy = argv.includes('--sloppy');
const forceRepl = argv.includes('-i');
const files = argv.filter((a) => !a.startsWith('-'));

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

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    `${BML_NAME} ${BML_VERSION}, a little Standard ML`,
    'Created by David M. Berry, University of Sussex, 2026.',
    '',
    '  bml                 strict repl (ill-typed lines are refused)',
    '  bml --sloppy        advisory repl (a clash is named; the line runs)',
    '  bml file.ml …       run files and exit',
    '  bml -i file.ml      run files, then stay at the prompt',
    '  bml --examples      copy the example programs here, to edit and run',
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
const bml = createInterpreter({ typecheck: sloppy ? 'report' : 'strict' });
bml.loadPrelude();


// What the REPL says when it opens. Who made it, where, and which build, so a
// screenshot of a session carries its own provenance.
function banner() {
  return [
    '',
    '------------------------------------------------------------',
    `${BML_NAME} ${BML_VERSION}, a little Standard ML${sloppy ? '  (advisory)' : ''}`,
    'Created by David M. Berry, University of Sussex, 2026.',
    'Based on Standard ML developed by Robin Milner, Mads Tofte and Robert Harper.',
    '',
    sloppy
      ? 'advisory: a clash is named and the line runs anyway.'
      : 'strict: use typecheck',
    'Type help for the forms, :quit to leave.',
    '------------------------------------------------------------',
    '',
  ].join('\n');
}

// `help` at the prompt. It is not a language expression and never was: in the
// game the console intercepts it before evaluation, and that interception lives
// in the game's adapter, so out here `help` was an unbound variable. A REPL that
// cannot tell you what it takes is not much of a teaching interpreter.
const HELP = `${BML_NAME} ${BML_VERSION}, a little Standard ML
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
  if (line === 'help' || line === ':help' || line === '?') { console.log(HELP); return true; }
  if (line.startsWith(':t ')) {
    const t = bml.typeReport(line.slice(3));
    console.log(t || 'no type: the checker could not read that');
    return true;
  }
  // `use "file.ml";` — SML's own way of reading a file at the top level.
  const use = line.match(/^use\s+"([^"]+)"\s*;?$/);
  if (use) return runFile(use[1]);

  const ty = bml.typeReport(line);
  const r = bml.run(line);
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '- ' });
rl.prompt();
rl.on('line', (line) => {
  if (step(line) === null) { rl.close(); return; }
  rl.prompt();
});
rl.on('close', () => { console.log(''); process.exit(0); });
