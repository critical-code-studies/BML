(* datatype declares a type by listing everything it can be. Then `case` takes
   one apart, and the checker warns if you forget a possibility. *)

datatype colour = Red | Green | Blue

fun name Red = "red"
  | name Green = "green"
  | name Blue = "blue"

val n = name Blue

(* A constructor may carry something. *)
datatype shape
  = Circle of real
  | Rect of real * real
  | Square of real

fun area (Circle r) = 3.14159 * r * r
  | area (Rect (w, h)) = w * h
  | area (Square s) = s * s

val shapes = [Circle 1.0, Rect (2.0, 3.0), Square 4.0]
val areas = List.map area shapes

(* Recursive types are the interesting ones: a type defined in terms of itself. *)
datatype expr
  = Num of int
  | Add of expr * expr
  | Mul of expr * expr
  | Neg of expr

fun eval (Num n) = n
  | eval (Add (a, b)) = eval a + eval b
  | eval (Mul (a, b)) = eval a * eval b
  | eval (Neg a) = 0 - eval a

(* (2 + 3) * ~4 *)
val tree = Mul (Add (Num 2, Num 3), Neg (Num 4))
val value = eval tree

fun show (Num n) = Int.toString n
  | show (Add (a, b)) = "(" ^ show a ^ " + " ^ show b ^ ")"
  | show (Mul (a, b)) = "(" ^ show a ^ " * " ^ show b ^ ")"
  | show (Neg a) = "~" ^ show a

val printed = show tree
