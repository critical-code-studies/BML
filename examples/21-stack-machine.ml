(* Reverse Polish, and the machine that runs it.

   "3 4 +" pushes two numbers and then adds them. The whole machine is a fold
   over the instructions, carrying a stack. *)

datatype op = Push of int | Plus | Times | Minus

fun step (Push n, stack) = n :: stack
  | step (Plus, b :: a :: rest) = (a + b) :: rest
  | step (Times, b :: a :: rest) = (a * b) :: rest
  | step (Minus, b :: a :: rest) = (a - b) :: rest
  | step (_, stack) = stack

fun run program = foldl step nil program

(* (2 + 3) * 4 *)
val program = [Push 2, Push 3, Plus, Push 4, Times]
val stack = run program
val answer = hd stack

(* Reading a program out of a string, which is a small parser. *)
fun parseWord "+" = Plus
  | parseWord "*" = Times
  | parseWord "-" = Minus
  | parseWord w = Push (getOpt (Int.fromString w, 0))

fun parse text = map parseWord (String.tokens (fn c => c = #" ") text)

val fromText = run (parse "2 3 + 4 *")
val twenty = hd fromText

(* Compiling the expression tree from the previous example into this machine
   is a fold the other way: syntax in, instructions out. *)
datatype expr = Num of int | Add of expr * expr | Mul of expr * expr

fun compile (Num n) = [Push n]
  | compile (Add (a, b)) = compile a @ compile b @ [Plus]
  | compile (Mul (a, b)) = compile a @ compile b @ [Times]

val compiled = compile (Mul (Add (Num 2, Num 3), Num 4))
val andItRuns = hd (run compiled)
