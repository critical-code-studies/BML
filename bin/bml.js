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
import {
  createInterpreter, smlEcho, joinProgram,
  BML_NAME, BML_VERSION, BML_CREDIT,
} from '../src/index.js';

const argv = process.argv.slice(2);
const sloppy = argv.includes('--sloppy');
const forceRepl = argv.includes('-i');
const files = argv.filter((a) => !a.startsWith('-'));

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    `${BML_NAME} ${BML_VERSION} — a little Standard ML`,
    '',
    '  bml                 strict repl (ill-typed lines are refused)',
    '  bml --sloppy        advisory repl (a clash is named; the line runs)',
    '  bml file.ml …       run files and exit',
    '  bml -i file.ml      run files, then stay at the prompt',
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

// Run one line and print what Standard ML would print. Returns false if the
// line was refused, so a file can stop at its first error rather than pressing
// on with half a program loaded.
function step(src) {
  const line = String(src).trim();
  if (!line) return true;
  if (line === ':quit' || line === ':q') return null;
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

console.log(`${BML_NAME} ${BML_VERSION}${sloppy ? '  (advisory)' : ''}   :quit to leave, :t for a type`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '- ' });
rl.prompt();
rl.on('line', (line) => {
  if (step(line) === null) { rl.close(); return; }
  rl.prompt();
});
rl.on('close', () => { console.log(''); process.exit(0); });
