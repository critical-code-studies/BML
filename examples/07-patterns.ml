(* Patterns. Taking a value apart by writing down its shape. *)

fun describe 0 = "nothing"
  | describe 1 = "one"
  | describe _ = "several"

val several = describe 7

(* The wildcard matches anything and binds nothing, which says plainly that
   you do not care what is there. *)
fun isEmpty nil = true
  | isEmpty _ = false

(* A pattern can name the whole thing AND take it apart, with `as`. *)
fun longer (whole as h :: _) = (length whole, h)
  | longer nil = (0, 0)

val pair = longer [7, 8, 9]

(* Patterns nest as deep as the value does. *)
fun secondOf (_ :: second :: _) = SOME second
  | secondOf _ = NONE

val two = secondOf [1, 2, 3]

(* `case` is the same matching, written as an expression. *)
fun classify n =
  case (n mod 3, n mod 5) of
      (0, 0) => "fifteen"
    | (0, _) => "three"
    | (_, 0) => "five"
    | _      => "neither"

val fifteen = classify 30
