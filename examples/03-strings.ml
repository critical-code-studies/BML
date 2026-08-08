(* Strings and characters. Two types, not one. *)

val hello = "hello"
val shout = hello ^ ", world"
val letter = #"h"

val howLong = size shout
val third = String.sub (shout, 2)
val middle = String.substring (shout, 7, 5)

(* A string is not a list of characters, but it converts both ways. *)
val letters = explode "abc"
val backAgain = implode letters

val loud = String.map Char.toUpper hello
val backwards = String.rev hello

(* Character codes, for when you want the number under the letter. *)
val code = ord #"A"
val fromCode = chr 66

val isLetter = Char.isAlpha #"x"
val isNumber = Char.isDigit #"7"

(* Splitting on a character, and joining back. *)
val words = String.tokens (fn c => c = #" ") "the quick brown fox"
val rejoined = String.concatWith "-" words
