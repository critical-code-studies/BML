(* The Collatz sequence. Halve it if it is even, treble it and add one if it
   is odd, and see how long it takes to reach one.

   Nobody has proved that it always does. *)

fun step n = if n mod 2 = 0 then n div 2 else 3 * n + 1

fun sequence 1 = [1]
  | sequence n = n :: sequence (step n)

val fromSeven = sequence 7

(* How many steps, without keeping the numbers. *)
fun steps (1, count) = count
  | steps (n, count) = steps (step n, count + 1)

val sevenTakes = steps (7, 0)

(* The longest run under a hundred. `foldl` walks the list carrying the best
   so far, which is the accumulator idea again. *)
fun longestUnder limit =
  let
    val candidates = List.tabulate (limit - 1, fn i => i + 1)
    fun better (n, best as (_, bestLen)) =
      let val len = steps (n, 0)
      in if len > bestLen then (n, len) else best end
  in
    List.foldl better (1, 0) candidates
  end

val worst = longestUnder 100
