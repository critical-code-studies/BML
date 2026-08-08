(* Recursion. A function that calls itself, and how it stops. *)

fun countdown 0 = "liftoff"
  | countdown n = countdown (n - 1)

val launched = countdown 5

(* Factorial, the first recursive function anybody writes. *)
fun fact 0 = 1
  | fact n = n * fact (n - 1)

val bigNumber = fact 12

(* The clauses are tried in order, so put the stopping case first. Written the
   other way round, the second clause would match everything and the first
   would never be reached. *)
fun sumTo 0 = 0
  | sumTo n = n + sumTo (n - 1)

val fiveThousand = sumTo 100

(* Fibonacci, written the slow and obvious way. Every call makes two more. *)
fun fib 0 = 0
  | fib 1 = 1
  | fib n = fib (n - 1) + fib (n - 2)

val tenth = fib 10
