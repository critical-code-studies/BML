(* Eight queens. Place a queen on each row of a chessboard so that no two share
   a column or a diagonal. The whole search is one recursive function and a
   safety test; there is no board and nothing is ever overwritten. *)

fun upTo (a, b) = if a > b then nil else a :: upTo (a + 1, b)

(* A placement is a list of column numbers, one per row, most recent first.
   Two queens threaten each other if they share a column or a diagonal, and the
   row distance is however far down the list the earlier one sits. *)
fun safe (col, placed) =
  let fun go (nil, _) = true
        | go (c :: rest, d) =
            c <> col andalso c - col <> d andalso col - c <> d
            andalso go (rest, d + 1)
  in go (placed, 1) end

fun queens n =
  let fun place 0 = [nil]
        | place k =
            List.concat
              (List.map
                (fn placed =>
                   List.filter (fn p => not (List.null p))
                     (List.map (fn c => if safe (c, placed) then c :: placed else nil)
                               (upTo (1, n))))
                (place (k - 1)))
  in place n end

val solutions = queens 6
val howMany = List.length solutions
val first = hd solutions

(* Draw one, so you can check it by eye. *)
fun row (col, n) =
  String.concat (List.map (fn c => if c = col then " Q" else " .") (upTo (1, n)))

fun board placed =
  String.concatWith "\n" (List.map (fn c => row (c, List.length placed)) placed)

val picture = board first
