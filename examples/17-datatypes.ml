(* Types of your own. A datatype lists every shape a value can have, and the
   compiler then knows there are no others. *)

datatype colour = Red | Green | Blue

fun name Red = "red"
  | name Green = "green"
  | name Blue = "blue"

val whatIsIt = name Green

(* A constructor may carry something. *)
datatype shape =
    Circle of real
  | Rect of real * real
  | Square of real

fun area (Circle r) = 3.14159 * r * r
  | area (Rect (w, h)) = w * h
  | area (Square s) = s * s

val shapes = [Circle 1.0, Rect (2.0, 3.0), Square 4.0]
val areas = map area shapes

(* Leave a case out and the checker warns that the match is not exhaustive.
   The program still runs, as Standard ML allows, and raises Match if it ever
   meets the case you left out. *)
fun isRound (Circle _) = true
  | isRound _ = false

val roundOnes = List.filter isRound shapes

(* A type parameter, so the same shape works for any contents. *)
datatype 'a labelled = Labelled of string * 'a

val tagged = Labelled ("count", 42)
fun unlabel (Labelled (_, x)) = x
