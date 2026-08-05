(* FizzBuzz, the traditional way to find out whether a language is any fun.
   Note there is no loop here: a range is a list, and you map over it. *)

fun upTo (a, b) = if a > b then nil else a :: upTo (a + 1, b)

fun fizz n =
  if n mod 15 = 0 then "FizzBuzz"
  else if n mod 3 = 0 then "Fizz"
  else if n mod 5 = 0 then "Buzz"
  else Int.toString n

val answer = List.map fizz (upTo (1, 20))

(* One line, if you like: *)
val oneLine = String.concatWith " " (List.map fizz (upTo (1, 15)))
