# BML

**Version 0.5.0** · MIT · [critical-code-studies/BML](https://github.com/critical-code-studies/BML)

**BML created by David M. Berry, University of Sussex, 2026.**
Based on Standard ML developed by Robin Milner, Mads Tofte, and Robert Harper.
With thanks to Robert Harper for the inspiration in his *Introduction to
Standard ML* (1986), and to Åke Wikström for *Functional Programming Using
Standard ML* (1987).

A little Standard ML, in plain JavaScript. No build step and no dependencies.

BML is a small implementation of Standard ML, the lexer, the parser, the type
inference, the standard library, all of it short enough that one person can hold
it in mind and follow what happens to a program between the typing and the
answer.

The compiler is opaque, the type error arrives from nowhere, and the student
learns to propitiate the machine rather than to understand it. Iteracy, by which
I mean the capacity to read and write computational processes rather than merely
operate them, depends on there being something available to read, and an
instrument whose parameters are visible is a different sort of object from one
whose parameters are hidden. A teaching interpreter can be the first sort, and
this one tries to be. The standard library is written in BML itself and loaded as
source, so the `map` you call is the `map` you could have written, and you can
open the file and confirm that it is.

Types are inferred rather than declared, a program that does not typecheck does
not run, and the tradition running from Milner's LCF is one of machine-checked
proof, of formality as a working condition rather than as decoration. Whether a
language of that kind teaches anything a survivor of a ruined world would need is
a question the game this grew inside asks rather than answers.

```
$ node bin/bml.js
BML 0.5.0, a little Standard ML
Created by David M. Berry, University of Sussex, 2026.
Based on Standard ML developed by Robin Milner, Mads Tofte and Robert Harper.

strict: use typecheck
Type help for the forms, :quit to leave.

- fun fact 0 = 1
=   | fact n = n * fact (n - 1)
val fact = <fn> : int -> int
- fact 10
val it = 3628800 : int
- List.partition (fn x => x > 2) [1,2,3,4]
val it = ([3, 4], [1, 2]) : int list * int list
- val x : int = "hello"
ERR: string and int are not the same type
```

## What is here

The core language: `val`, `fun` (clausal, curried, tuple-argument), `fn`, `let`,
`case`, `datatype` with type variables, records, tuples, exceptions, mutable
references, `local`, and `infix`/`infixr`/`nonfix`/`op`. Modules: `structure`,
`signature`, and generative functors.

Types are inferred by Hindley-Milner with the occurs check, let-polymorphism and
the value restriction, with exhaustiveness warnings on `case`. The Basis subset
is written in BML itself and loaded as source, so you can open `src/basis.js` and
read the same `map` you would have written.

It is measured rather than described. Against the 32 example files from Robert
Harper's *Introduction to Standard ML* course, this build runs **320 of 395
top-level declarations (81%)** as written, with no translation:

```
node tools/isml-conformance.mjs
```

That corpus is Harper's teaching material. The harness fetches it on first run
into a gitignored cache; it is **not** in this repository and is not
redistributed here.

## Examples

Nine of them, simple to less so, in [examples/](examples/). Each runs on its own
under the default checker:

```
bml examples/09-eight-queens.ml
```

If you installed rather than cloned, they are inside `node_modules` where nobody
will find them. Copy them somewhere you can edit:

```
bml --examples
```

That writes a `bml-examples/` directory beside you and refuses to write over one
that is already there. It is a command rather than something the install does on
its own: a package should not put files in your working directory because you
installed it.

## Using it

Straight from a clone:

```
node bin/bml.js
```

Or install it, which puts `bml` on the path:

```
npm install github:critical-code-studies/BML
```

```
bml                 strict repl (a line that does not typecheck is refused)
bml --sloppy        advisory repl (the clash is named; the line runs)
bml file.ml …       run files and exit
bml -i file.ml      run files, then stay at the prompt
bml --examples      copy the examples here, to edit and run
bml --version       which build this is, and whether a newer one exists
```

At the prompt: `help` lists the forms, `:t <expr>` gives a type without
evaluating, `use "file.ml";` reads a file in, `:quit` leaves.

As a library:

```js
import { createInterpreter } from 'bml-lang';

const bml = createInterpreter({ typecheck: 'strict' });
bml.loadPrelude();
bml.run('3 + 4').text;        // '7'
bml.typeReport('fn x => x');  // "'a -> 'a"
```

A host supplies its own verbs through `builtins`, and answers the language's
questions through `hooks`, so that the language calls host policy and never
reads host tables. `typecheck` is `'off' | 'report' | 'strict'` and `printing` is
`'sml' | 'bare'`.

## Where it came from

BML grew inside [NostOS](https://github.com/dmberry/nostos), a game in which you
type this language into the terminals of derelict machines. It still runs there,
under the in-fiction name AI-ML, through the same `createInterpreter`, differing
only in what it is passed: the game is **advisory** everywhere, because a machine
in a ruin should say what it worked out and let the operator decide.

The history in this repository is that history. `git log` reaches back to the
day the language got its name, and the file the whole thing grew inside travels
with it for the record even though the file itself is gone.

## What it is not

Not SML '97. The full Basis of 47 structures, `abstype`, sharing constraints and
functor signatures are years of work no teaching implementation attempts.

Known gaps, kept honest by a register of 16 entries that a test walks: no
`abstype`, no `open`, no `while`, no `withtype`, and nothing outside `List`, `String`, `Char`, `Int`, `Real`, `Bool`, `Option`,
`ListPair`. Identifiers are lower-cased, which Standard ML does not do, so `foo`
and `Foo` name the same value. Recursion depth is the host's rather than the
interpreter's, so a deep non-tail recursion can exhaust the JavaScript stack
before the step budget notices.

## The update check

An interactive session asks GitHub, once a day, whether a newer BML exists, and
says so if there is one. It fetches one public file, `package.json`, and sends
nothing: no identity, no telemetry, no record of what you typed. What a web
server can infer is that some address asked for a public file, which is equally
true of reading this page.

It runs in an interactive session only. Not when you run a file, not in a pipe,
not in CI, not inside a test. It times out after a second and a half and fails
silently, so it cannot delay or break anything.

Turn it off and it never runs:

```
export BML_NO_UPDATE_CHECK=1
```

`bml --version` checks on request and tells you either way.

## Licence

MIT. See [LICENSE](LICENSE). Harper's example corpus is his own teaching material
and is not included here under any licence; the conformance harness fetches it.

## Credit

At the head of this file. BML runs inside
[NostOS](https://github.com/dmberry/nostos) under the in-fiction name AI-ML.
