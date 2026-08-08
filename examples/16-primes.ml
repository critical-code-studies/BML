(* Primes, by sieve. Keep the head, throw away everything it divides, repeat. *)

fun sieve nil = nil
  | sieve (p :: rest) = p :: sieve (List.filter (fn n => n mod p <> 0) rest)

fun upTo n = List.tabulate (n - 1, fn i => i + 2)

val primes = sieve (upTo 50)

(* Trial division, the other way round: ask whether anything divides it. *)
fun isPrime n =
  n > 1 andalso
  List.all (fn d => n mod d <> 0) (List.tabulate (n - 2, fn i => i + 2))

val seventeen = isPrime 17
val twentyOne = isPrime 21

(* The prime factors of a number, smallest first. *)
fun factor (n, d) =
  if n = 1 then nil
  else if n mod d = 0 then d :: factor (n div d, d)
  else factor (n, d + 1)

fun factors n = factor (n, 2)

val of60 = factors 60
val of97 = factors 97
