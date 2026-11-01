/**
 * Result of the last Stockfish verification run (`pnpm verify:puzzles`).
 * Generated; do not edit by hand. It applies only while `puzzleSetHash`
 * matches the current puzzle set.
 * @module @hodos/chess/verification
 */
export const STOCKFISH_VERIFICATION: { readonly engine: string; readonly depth: number; readonly date: string; readonly puzzleSetHash: string; readonly verified: readonly string[] } = {
  "engine": "Stockfish 17.1",
  "depth": 18,
  "date": "2026-10-26",
  "puzzleSetHash": "32a71cb342050244fe94d59d27ba3b8a2b798dabbd0d5f8b7eeba02c442c2b14",
  "verified": [
    "double-queen-rook",
    "double-queen-rook-m",
    "double-pawn-knights",
    "double-pawn-knights-m",
    "double-queen-corner",
    "double-queen-corner-m",
    "fork-royal-a8",
    "fork-royal-a8-m",
    "fork-king-queen-e7",
    "fork-king-queen-e7-m",
    "fork-corner-f7",
    "fork-queen-c6",
    "fork-back-rank-d7",
    "fork-queen-e6",
    "fork-queen-rook-f6",
    "pin-rook-queen-e",
    "pin-rook-queen-e-m",
    "pin-bishop-queen",
    "pin-bishop-queen-m",
    "pin-rank-queen",
    "pin-long-diagonal",
    "skewer-rank-rook",
    "skewer-rank-rook-m",
    "skewer-bishop-queen",
    "skewer-file-queen",
    "skewer-file-queen-m",
    "skewer-long-diagonal"
  ]
}
