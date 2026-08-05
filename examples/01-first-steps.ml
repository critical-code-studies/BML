(* First steps. Run me:  bml examples/01-first-steps.ml *)

val greeting = "hello, world"

val answer = 6 * 7

(* int and real are different types and do not mix. There are ways across. *)
val whole = 7
val fraction = 7.0 / 2.0
val crossed = real whole + 0.5

(* A negative number is written with a tilde. The minus sign is binary only. *)
val below = ~3
val gap = 3 - 10

(* Truncating division and its remainder, both flooring, as Standard ML has. *)
val q = 17 div 5
val r = 17 mod 5

val truth = 1 < 2 andalso 2 < 3
