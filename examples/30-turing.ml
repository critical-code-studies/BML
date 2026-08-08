(* A Turing machine, in about forty lines.

   The tape is two lists back to back: what is behind the head, reversed, and
   what is in front of it. Moving is then taking from one and pushing to the
   other, which costs nothing whichever way you go. *)

datatype symbol = Blank | Zero | One
datatype move = L | R | Stay

type tape = symbol list * symbol list      (* behind (reversed), ahead *)

fun read (_, nil) = Blank
  | read (_, s :: _) = s

fun write (behind, nil) s = (behind, [s])
  | write (behind, _ :: ahead) s = (behind, s :: ahead)

fun shift ((nil, ahead), L) = (nil, Blank :: ahead)
  | shift ((b :: behind, ahead), L) = (behind, b :: ahead)
  | shift ((behind, nil), R) = (Blank :: behind, nil)
  | shift ((behind, a :: ahead), R) = (a :: behind, ahead)
  | shift (t, Stay) = t

(* A machine is a function from (state, symbol) to what to do about it. *)
fun run (rules, state, tape, fuel) =
  if fuel <= 0 then (state, tape)
  else
    case rules (state, read tape) of
        NONE => (state, tape)
      | SOME (state', out, dir) =>
          run (rules, state', shift (write tape out, dir), fuel - 1)

(* A machine that flips every bit until it runs out of tape. *)
fun flipper ("go", Zero) = SOME ("go", One, R)
  | flipper ("go", One) = SOME ("go", Zero, R)
  | flipper ("go", Blank) = SOME ("halt", Blank, Stay)
  | flipper _ = NONE

val start = (nil, [Zero, One, One, Zero])
val (endState, (behind, ahead)) = run (flipper, "go", start, 20)
val flipped = rev behind

(* A machine that adds one to a binary number, working from the right. *)
fun increment ("right", Blank) = SOME ("carry", Blank, L)
  | increment ("right", s) = SOME ("right", s, R)
  | increment ("carry", One) = SOME ("carry", Zero, L)
  | increment ("carry", Zero) = SOME ("done", One, Stay)
  | increment ("carry", Blank) = SOME ("done", One, Stay)
  | increment _ = NONE

val three = (nil, [Zero, One, One])
val (afterState, (left, right)) = run (increment, "right", three, 20)
val four = rev left @ right
