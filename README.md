# BML

**Version 0.42.0** · GPL-3.0-or-later · [critical-code-studies/BML](https://github.com/critical-code-studies/BML)

**BML created by David M. Berry, University of Sussex, 2026.**
Based on Standard ML developed by Robin Milner, Mads Tofte, and Robert Harper.
With thanks to Robert Harper for the inspiration in his *Introduction to
Standard ML* (1986), and to Åke Wikström for *Functional Programming Using
Standard ML* (1987).

A 2026 Standard ML, in plain JavaScript. No build step and no dependencies.

**[Try it in the browser →](https://critical-code-studies.github.io/BML/)** The
whole language runs in the browser: the same files, no server behind the prompt.

BML is an experimental 2026 implementation of Standard ML, the lexer, the
parser, the type inference, the standard library, all of it short enough that
one person can hold it in mind and follow what happens to a program between the
typing and the answer.

The standard library is written in BML itself and loaded as source, so the `map`
you call is the `map` you could have written, and you can open the file and
confirm that it is.

Types are inferred rather than declared, a program that does not typecheck does
not run, and the tradition running from Milner's LCF is one of machine-checked
proof, of formality as a working condition rather than as decoration. Whether a
language of that kind teaches anything a survivor of a ruined world would need is
a question the game this grew inside asks rather than answers.

```
$ node bin/bml.js
BML 0.40.0, a 2026 Standard ML
Created by David M. Berry, University of Sussex, 2026.
Based on Standard ML developed by Robin Milner, Mads Tofte and Robert Harper.

strict: use typecheck
Type help for more info, :quit to leave.

- fun fact 0 = 1
val fact = <fn> : int -> int
-   | fact n = n * fact (n - 1)
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
`case`, `datatype` with type variables, `abstype`, `withtype`, type
abbreviations, records, tuples, `as` patterns, exceptions (raised, handled, and
the standard ones catchable by name), mutable references, `while … do`,
`local`, `open`, and `infix`/`infixr`/`nonfix`/`op`. Modules: `structure`,
`signature` with transparent and opaque ascription, `sharing type`,
`where type`, and generative functors.

Identifiers are case-sensitive, as Standard ML's are: `foo` and `Foo` are two
names.

`int` is 53-bit, which is what `Int.precision` and `Int.maxInt` report, and an
operation that leaves the range raises `Overflow` rather than quietly becoming a
float. `IntInf` is unbounded. Reals overflow to `inf`, as Standard ML's do.

Tail calls are proper, as the Definition requires, so an accumulator loop or a
continuation-passing program runs to whatever depth the step budget allows
rather than to whatever the host stack has left.

Files are read and written through `TextIO`, as the Basis has it: `openIn`,
`inputAll`, `inputLine`, `closeIn`, and `openOut`, `openAppend`, `output`,
`output1`, `flushOut`, `closeOut`. A program written from the Basis runs here
unchanged, so the library exercise that everyone is set in their first week
works as it is written:

```sml
fun shelve title =
  let val g = TextIO.openAppend "library.txt"
  in TextIO.output (g, title ^ "\n"); TextIO.closeOut g end

val _ = shelve "Giant Brains"
val _ = shelve "Ficciones"
val shelf = TextIO.inputAll (TextIO.openIn "library.txt")
```

`openAppend` makes the file if it is not there, as the Basis says, so nothing
has to be created first.

The disk comes from the host. At the command line that is the real filesystem,
relative to where you ran `bml`. In the browser there is none, and a program
that opens a file is told so rather than being handed an empty string. A stream
is its filename here, so `closeIn` and `closeOut` hold nothing open and are
no-ops; a Basis program still has to call them, and calling them is still right.

Types are inferred by Hindley-Milner with the occurs check, let-polymorphism and
the value restriction, with exhaustiveness warnings on `case`. The Basis Library
subset is written in BML itself and loaded as source, so you can open
`src/basis.js` and read the same `map` you would have written.

It is measured rather than described, two ways. Against the 32 example files
from Robert Harper's *Introduction to Standard ML* course, this build runs
**355 of 408 top-level declarations (87%)** as written, with no translation:

```
node tools/isml-conformance.mjs
```

And against a checklist of the Definition — 100 features, one case each, passing
only on an exact match — it scores **100/100**:

```
node tools/sml-checklist.mjs
```

The corpus is the figure to trust, being somebody else's programs rather than a
list written here; the checklist catches what the corpus happens not to use.
Harper's files contain no `while` and no arrays, so the corpus had nothing to
say about either while both were missing.

The harness reports what the rest ARE, which took some working out. Of the 53
that do not run, 7 raise as Standard ML would, 13 are refused by the type
checker and some of those refusals are correct (Harper prints deliberate
errors: `typval.sml` line 8 is four ill-typed expressions in a row, put there
to show a student what one looks like), 11 fail on a name an earlier failure
would have bound, and 14 name something the file never defines at all. That
leaves **8 this build genuinely cannot read**, and two of those are a LaTeX
escape left in Harper's source.

So 100% is not reachable, and the ceiling is not a fact about this build. Parts
of the corpus are teaching listings that have never been through a compiler.

That corpus is Harper's teaching material. The harness fetches it on first run
into a gitignored cache; it is **not** in this repository and is not
redistributed here.

## Examples

Thirty programs in `examples/`, in six categories in teaching order: first
steps, recursion, lists, types of your own, modules, and programs. The last
runs FizzBuzz three ways, eight queens, Conway's Life, and a Turing machine in
forty lines. All thirty run under the default strict checker.

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

**Tab completes.** A bare prefix offers every name in scope and the keywords;
after a dot it offers that structure's members, so `List.f` gives `List.filter`,
`List.find`, `List.foldl`, `List.foldr`. It fills in as far as the candidates
agree and lists them only when they diverge. The same rule runs at the prompt in
the browser, because it is one function in the language rather than one in each.

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

Not SML '97. The full Basis Library of 47 structures, sharing constraints and functor
signatures are years of work no teaching implementation attempts.

The gaps are catalogued rather than described, in a register that a test walks
so that fixing one turns the test red and names the entry to delete. The
register is currently empty. About 13% of Harper's corpus does not run as
written, and some of that cannot: parts of it were never valid Standard ML.

The Basis Library is 29 structures of roughly 47, and 430 members. There is no `OS`:
this runs in the browser, so there is no OS support as such. `Date` is
therefore UTC only, and `fromTimeLocal` and `fromTimeUniv` are not able to
give the OS time.

**There is no `word` type.** A word literal is an `int` here — `0w5` has type
`int` and prints as `5` — so nothing can tell a word from a whole number and
the overloaded `+` has nothing to dispatch on: `0wxFFFFFFFF + 0w1` answers
`4294967296` where a 32-bit word gives `0wx0`.

What is written against `Word` itself does wrap, and that is now the whole
structure rather than part of it. `Word.+ (0wxFFFFFFFF, 0w1)` is `0wx0`,
`Word.- (0w0, 0w1)` is `0wxFFFFFFFF`, `Word.~ 0w1` is `0wxFFFFFFFF`, `Word8`
does the same at eight bits, and `Word.toString` prints the hex the Basis asks
for. So wrapping is expressible; it is the bare infix that is not.

The type itself is a decision rather than an omission. It would be a new value
tag through the lexer, the parser, the evaluator, the printer, equality, the
checker's base types, the primitives and the Basis, for a feature no program in
the corpus uses — Harper's files contain no words at all.

A `Substring` is likewise the string it denotes rather than a window onto a
base, so `Substring.base` reports an offset of 0 whatever the substring was cut
from. Both are said here rather than discovered.

**Non-tail** recursion depth is the host's rather than the interpreter's.
Measured, a first run manages about **1,200** and about 4,200 once the browser
has compiled the evaluator, after which `fun fact n = … n * fact (n - 1)` runs
out of JavaScript stack before the step budget notices. Tail calls are proper,
as the Definition requires, so an accumulator loop or a continuation-passing
program runs to whatever depth the step budget allows and does not touch the
stack at all.

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

**GNU General Public License, version 3 or (at your option) any later version.**
The full text is in [LICENSE](LICENSE).

Copyright © 2026 David M. Berry, sole copyright holder.

**Every version is covered, including the ones released before this one.** BML
was published under the MIT licence up to 0.39.1 and is relicensed here to the
GPL, retrospectively, which the copyright holder may do. One thing that cannot
be undone and is stated rather than glossed: a copy somebody already received
under MIT stays usable by that person under MIT, because a licence already
granted cannot be withdrawn. Everything distributed from 0.40.0 onward, and
every earlier version as re-published here, is GPL.

Harper's example corpus is his own teaching material and is not included here
under any licence; the conformance harness fetches it.

## Credit

At the head of this file. BML runs inside
[NostOS](https://github.com/dmberry/nostos) under the in-fiction name AI-ML.
