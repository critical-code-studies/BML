#!/usr/bin/env node
//
// BML — a little Standard ML. The read-eval-print loop.
//
//   node bin/bml.js              strict: a line that does not typecheck is refused
//   node bin/bml.js --sloppy     advisory: a clash is named and the line still runs
//   node bin/bml.js file.ml …    run files, then exit (add -i to stay at the prompt)
//
// AI-ML created by David M. Berry, 2026. Based on Standard ML developed by
// Robin Milner, Mads Tofte, and Robert Harper. Many thanks to Robert Harper for
// the inspiration in his book "Introduction to Standard ML" (1986), and to Åke
// Wikström for "Functional Programming Using Standard ML" (1987).
//
// This is the language out of the game it grew in. It shares one interpreter
// with the NostBook's `ml`, and the only difference is the mode: the game is
// advisory everywhere, because a machine in a ruin should say what it worked
// out and let the operator decide. Here the default is strict, because that is
// what makes it an ML.

import readline from 'node:readline';
import fs from 'node:fs';
import {
  runRonml, typeReport, smlEcho, loadPrelude,
  AIML_NAME, AIML_VERSION, AIML_CREDIT, joinProgram,
} from '../src/game/ai_ml.js';

const argv = process.argv.slice(2);
const sloppy = argv.includes('--sloppy');
const forceRepl = argv.includes('-i');
const files = argv.filter((a) => !a.startsWith('-'));

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    `${AIML_NAME} ${AIML_VERSION} — a little Standard ML`,
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
    ...AIML_CREDIT.map((l) => `  ${l}`),
  ].join('\n'));
  process.exit(0);
}

// One session for the whole run: bindings, fixity and datatypes persist from
// line to line, as they do at any ML top level.
const ctx = {
  station: 'laptop',
  session: {},
  types: true,
  typecheck: sloppy ? 'report' : 'strict',
};
await loadPrelude(ctx);

// Run one line and print what Standard ML would print. Returns false if the
// line was refused, so a file can stop at its first error rather than pressing
// on with half a program loaded.
function step(src) {
  const line = String(src).trim();
  if (!line) return true;
  if (line === ':quit' || line === ':q') return null;
  if (line.startsWith(':t ')) {
    const t = typeReport(line.slice(3), ctx);
    console.log(t || 'no type: the checker could not read that');
    return true;
  }
  // `use "file.ml";` — SML's own way of reading a file at the top level.
  const use = line.match(/^use\s+"([^"]+)"\s*;?$/);
  if (use) return runFile(use[1]);

  const ty = typeReport(line, ctx);
  const r = runRonml(line, ctx);
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

console.log(`${AIML_NAME} ${AIML_VERSION}${sloppy ? '  (advisory)' : ''}   :quit to leave, :t for a type`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '- ' });
rl.prompt();
rl.on('line', (line) => {
  if (step(line) === null) { rl.close(); return; }
  rl.prompt();
});
rl.on('close', () => { console.log(''); process.exit(0); });
