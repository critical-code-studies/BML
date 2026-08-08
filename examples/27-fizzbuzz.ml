(* FizzBuzz, three ways, because the differences are the interesting part. *)

(* By nested ifs, which is how most people write it first. *)
fun fizz1 n =
  if n mod 15 = 0 then "FizzBuzz"
  else if n mod 3 = 0 then "Fizz"
  else if n mod 5 = 0 then "Buzz"
  else Int.toString n

(* By matching on the pair of remainders, which puts the four cases side by
   side instead of nesting them. *)
fun fizz2 n =
  case (n mod 3, n mod 5) of
      (0, 0) => "FizzBuzz"
    | (0, _) => "Fizz"
    | (_, 0) => "Buzz"
    | _      => Int.toString n

(* By building the word out of its parts, and falling back to the number when
   nothing was added. *)
fun fizz3 n =
  let
    val word = (if n mod 3 = 0 then "Fizz" else "")
             ^ (if n mod 5 = 0 then "Buzz" else "")
  in
    if word = "" then Int.toString n else word
  end

val oneToTwenty = List.tabulate (20, fn i => i + 1)

val first = map fizz1 oneToTwenty
val second = map fizz2 oneToTwenty
val third = map fizz3 oneToTwenty

(* All three agree, which is worth checking rather than assuming. *)
val agree = first = second andalso second = third

val printed = String.concatWith " " third
