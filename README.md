# BML

A little Standard ML.

**The code is not here yet.** BML is being extracted from the interpreter that
runs inside [NostOS](https://github.com/dmberry/nostos), where it grew as the
language you type into the game's terminals and load into its machines. This
repository holds the name while that extraction finishes.

## What it is

A small implementation of Standard ML in plain JavaScript. No build step, no
dependencies, no `package.json`: it runs under `node` and in a browser as ES
modules.

The core language is there, with `val`, `fun` (clausal, curried, tuple-argument),
`fn`, `let`, `case`, `datatype` with type variables, records, exceptions,
mutable references, `local`, and `infix`/`infixr`/`nonfix`/`op`. So are modules:
`structure`, `signature`, and generative functors. Types are inferred by
Hindley-Milner with the occurs check, let-polymorphism, and the value
restriction, with exhaustiveness warnings on `case`. The Basis subset is written
in BML itself and loaded as source, so a reader can open the library and see the
same `map` they would have written.

It is measured rather than described. Against the 32 example files from Robert
Harper's *Introduction to Standard ML* course, the current build runs **81% of
top-level declarations** as written, with no translation. That corpus is his
teaching material: the harness fetches it, and it is never vendored here.

## Two modes, one checker

In Standard ML a program that does not typecheck does not run, and on the command
line BML works that way. Inside the game it reports the clash and runs the line
anyway. That is the design rather than a shortcut: a machine in a ruin should say
what it worked out and let the operator decide. Same checker, same messages; the
only difference is whether the line then runs.

## Where the extraction has got to

| | |
|---|---|
| Language | done: core, modules, functors, inference, fixity, a Basis slice, strict mode |
| Lexer, parser | extracted |
| Evaluator, type checker | extracted |
| Library, diagnostics, entry point | still in the game adapter |
| REPL | works, still built on the adapter |

The plan, including what is deliberately absent and why, lives in
[docs/aiml-standalone-plan.md](https://github.com/dmberry/nostos/blob/main/docs/aiml-standalone-plan.md)
in the NostOS repository. Nothing is pushed here until the first commit can run a
REPL and pass its tests.

## Licence

MIT. See [LICENSE](LICENSE). Harper's example corpus is his own teaching material
and is not included here under any licence; the conformance harness fetches it.

## Credit

BML created by David M. Berry, 2026. It runs inside NostOS under the in-fiction
name AI-ML.

Based on Standard ML developed by Robin Milner, Mads Tofte, and Robert Harper.
Many thanks to Robert Harper for the inspiration in his book *Introduction to
Standard ML* (1986), and to Åke Wikström for *Functional Programming Using
Standard ML* (1987).
