(* Eight queens. Place eight so that none attacks another.

   The search is the whole program: try each row in turn, keep going if it is
   safe, and back up when nothing works. *)

fun safe (_, nil) = true
  | safe ((r, c), (r', c') :: rest) =
      r <> r' andalso c <> c'
      andalso r - c <> r' - c'
      andalso r + c <> r' + c'
      andalso safe ((r, c), rest)

fun rows n = List.tabulate (n, fn i => i + 1)

(* Place a queen in each column, left to right. `placed` is what has been put
   down so far, and the search backs up whenever nothing fits. *)
fun solve (n, col, placed) =
  if col > n then SOME (rev placed)
  else
    let
      fun tryRows nil = NONE
        | tryRows (r :: rs) =
            if safe ((r, col), placed) then
              case solve (n, col + 1, (r, col) :: placed) of
                  SOME answer => SOME answer
                | NONE => tryRows rs
            else tryRows rs
    in
      tryRows (rows n)
    end

val eight = solve (8, 1, nil)
val six = solve (6, 1, nil)

(* Four has solutions; three has none, and the search says so rather than
   looping or lying. *)
val four = solve (4, 1, nil)
val three = solve (3, 1, nil)

(* Just the rows, which is how the answer is usually written down. *)
val asRows = Option.map (map (fn (r, _) => r)) eight
