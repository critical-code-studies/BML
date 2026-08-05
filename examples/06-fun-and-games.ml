(* Things to play with. *)

fun upTo (a, b) = if a > b then nil else a :: upTo (a + 1, b)

(* --- Fibonacci, the slow way and the fast way ------------------------------ *)

fun slowFib 0 = 0
  | slowFib 1 = 1
  | slowFib n = slowFib (n - 1) + slowFib (n - 2)

val slow = slowFib 18

(* Carrying the last two along instead of recomputing everything. *)
fun fib n =
  let fun go (0, a, _) = a
        | go (k, a, b) = go (k - 1, b, a + b)
  in go (n, 0, 1) end

val fast = List.map fib (upTo (0, 20))

(* --- The Collatz conjecture. Nobody knows if this always stops. ------------ *)

fun collatz 1 = [1]
  | collatz n =
      if n mod 2 = 0 then n :: collatz (n div 2)
      else n :: collatz (3 * n + 1)

val twentySeven = List.length (collatz 27)
val hardest = collatz 27

(* --- Roman numerals -------------------------------------------------------- *)

fun roman 0 = ""
  | roman n =
      let val table = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
                       (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
                       (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
          fun go nil = ""
            | go ((v, s) :: rest) = if n >= v then s ^ roman (n - v) else go rest
      in go table end

val year = roman 2026
val fortyFour = roman 44

(* --- Reverse a string, and spot a palindrome ------------------------------- *)

val backwards = String.rev "stressed"

fun isPalindrome s =
  let val letters = List.filter Char.isAlpha (List.map Char.toLower (explode s))
  in letters = List.rev letters end

val yes = isPalindrome "A man, a plan, a canal, Panama"
val no = isPalindrome "not this one"

(* --- Caesar cipher, which is rot13 when the shift is 13 -------------------- *)

fun shiftChar k c =
  if Char.isLower c then chr ((ord c - 97 + k) mod 26 + 97)
  else if Char.isUpper c then chr ((ord c - 65 + k) mod 26 + 65)
  else c

fun caesar k s = implode (List.map (shiftChar k) (explode s))

val secret = caesar 13 "Attack at dawn"
val back = caesar 13 secret
