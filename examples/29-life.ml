(* Conway's Game of Life. A cell lives if it has two or three living
   neighbours, and is born if it has exactly three.

   The board is a list of the coordinates that are alive, so it can be any
   size and mostly costs nothing. *)

fun member (_, nil) = false
  | member (x, y :: ys) = x = y orelse member (x, ys)

fun neighbours (x, y) =
  [(x-1, y-1), (x, y-1), (x+1, y-1),
   (x-1, y),             (x+1, y),
   (x-1, y+1), (x, y+1), (x+1, y+1)]

fun livingNeighbours (cell, board) =
  length (List.filter (fn n => member (n, board)) (neighbours cell))

(* Everything that might be alive next turn: what is alive now, and everything
   next to it. Nothing else can change. *)
fun candidates board = List.concat (board :: map neighbours board)

fun dedup nil = nil
  | dedup (h :: t) = h :: dedup (List.filter (fn x => x <> h) t)

fun survives (cell, board) =
  let val n = livingNeighbours (cell, board)
  in if member (cell, board) then n = 2 orelse n = 3 else n = 3 end

fun step board = List.filter (fn c => survives (c, board)) (dedup (candidates board))

(* A blinker: three in a row, which flips between upright and flat forever. *)
val blinker = [(1, 0), (1, 1), (1, 2)]
val flipped = step blinker
val backAgain = step flipped
val itOscillates = backAgain = blinker

(* A block: four in a square, which never changes. *)
val block = [(0, 0), (0, 1), (1, 0), (1, 1)]
val stillThere = step block

(* A glider, which walks across the board. *)
val glider = [(1, 0), (2, 1), (0, 2), (1, 2), (2, 2)]
val moved = step (step (step (step glider)))
