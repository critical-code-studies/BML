(* Accumulators. Carrying the answer along, rather than building it on the
   way back out. *)

(* This one does its multiplying AFTER the recursive call returns, so every
   call is still waiting when the next one starts. *)
fun factSlow 0 = 1
  | factSlow n = n * factSlow (n - 1)

(* This one carries the answer in a second argument. Nothing is waiting when
   it calls itself, so the call needs no stack at all: it is a loop written as
   a function, which is how Standard ML says loop. *)
fun factFast (0, acc) = acc
  | factFast (n, acc) = factFast (n - 1, n * acc)

val same = (factSlow 10, factFast (10, 1))

(* Reversing a list is the same idea: take from one end, add to the other. *)
fun revInto (nil, acc) = acc
  | revInto (h :: t, acc) = revInto (t, h :: acc)

fun reverse xs = revInto (xs, nil)
val backwards = reverse [1, 2, 3, 4]

(* A hidden accumulator, so the caller does not have to know about it. *)
local
  fun go (nil, acc) = acc
    | go (h :: t, acc) = go (t, acc + h)
in
  fun total xs = go (xs, 0)
end

val ten = total [1, 2, 3, 4]
