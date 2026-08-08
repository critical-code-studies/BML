(* option. A value that might not be there, and a type that says so.

   Standard ML has no null. Something that may be missing has a type that
   admits it, and the checker then makes you deal with the missing case. *)

val here = SOME 42
val notHere = NONE

fun describe NONE = "nothing"
  | describe (SOME n) = "got " ^ Int.toString n

val said = describe here

(* Looking something up may fail, and the type says as much. *)
fun lookup (_, nil) = NONE
  | lookup (key, (k, v) :: rest) = if key = k then SOME v else lookup (key, rest)

val phone = [("ada", 1815), ("alan", 1912), ("grace", 1906)]
val found = lookup ("alan", phone)
val missing = lookup ("bob", phone)

(* getOpt supplies a default, so you can leave the option behind. *)
val year = getOpt (lookup ("grace", phone), 0)
val orZero = getOpt (missing, 0)

(* Option.map works inside the option, leaving NONE alone. *)
val century = Option.map (fn y => y div 100 + 1) found
val stillNothing = Option.map (fn y => y div 100) missing

(* valOf takes it out, and raises if there is nothing there. *)
val theYear = valOf found
val caught = (valOf missing) handle Option => ~1
