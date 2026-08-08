(* Truth, and choosing between two things. *)

val yes = true
val no = not yes

val bigger = 3 > 2
val same = "abc" = "abc"
val differs = #"a" <> #"b"

(* andalso and orelse stop as soon as the answer is settled, so the right-hand
   side of the first is never reached here. *)
fun safeDivide (n, d) = d <> 0 andalso n div d > 1

(* `if` is an expression: it has a value, and both branches are the same type. *)
fun sign n = if n > 0 then "positive" else if n < 0 then "negative" else "zero"

val ofFive = sign 5
val ofNone = sign 0

(* A comparison of your own, answering the order type the Basis uses. *)
fun compareLengths (a, b) =
  if size a < size b then LESS
  else if size a > size b then GREATER
  else EQUAL

val shorter = compareLengths ("ab", "abc")
