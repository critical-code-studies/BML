(* An expression, as a value. Then a function that works out what it means.

   This is the smallest interpreter there is, and the shape every larger one
   has: a datatype for the syntax, and a function over it. *)

datatype expr =
    Num of int
  | Add of expr * expr
  | Mul of expr * expr
  | Neg of expr

fun eval (Num n) = n
  | eval (Add (a, b)) = eval a + eval b
  | eval (Mul (a, b)) = eval a * eval b
  | eval (Neg a) = ~(eval a)

(* (2 + 3) * 4 *)
val sum = Mul (Add (Num 2, Num 3), Num 4)
val twenty = eval sum

(* Printing it back out. Parenthesised everywhere, which is ugly and correct. *)
fun show (Num n) = Int.toString n
  | show (Add (a, b)) = "(" ^ show a ^ " + " ^ show b ^ ")"
  | show (Mul (a, b)) = "(" ^ show a ^ " * " ^ show b ^ ")"
  | show (Neg a) = "~" ^ show a

val written = show sum

(* Another function over the same syntax. Adding one costs nothing, which is
   the argument for keeping the syntax as data. *)
fun size (Num _) = 1
  | size (Add (a, b)) = 1 + size a + size b
  | size (Mul (a, b)) = 1 + size a + size b
  | size (Neg a) = 1 + size a

val howBig = size sum

(* Simplification: anything times zero is zero, anything plus zero is itself. *)
fun simplify (Add (a, Num 0)) = simplify a
  | simplify (Add (Num 0, b)) = simplify b
  | simplify (Mul (_, Num 0)) = Num 0
  | simplify (Mul (Num 0, _)) = Num 0
  | simplify (Add (a, b)) = Add (simplify a, simplify b)
  | simplify (Mul (a, b)) = Mul (simplify a, simplify b)
  | simplify e = e

val tidied = show (simplify (Add (Mul (Num 5, Num 0), Num 7)))
