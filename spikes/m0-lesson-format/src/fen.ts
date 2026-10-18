// Plugin-style semantic check for `position.fen` (the "legal FEN" example in lesson-ir.md §4).
// Structural legality only: it does not check that the side not to move is out of check.

export function checkFen(fen: string): string | null {
  const parts = fen.trim().split(/\s+/)
  if (parts.length !== 6) return `FEN needs 6 space-separated fields, got ${parts.length}`
  const [board, side, castling, ep, half, full] = parts as [string, string, string, string, string, string]

  const ranks = board.split('/')
  if (ranks.length !== 8) return `FEN board needs 8 ranks, got ${ranks.length}`
  const count: Record<string, number> = {}
  for (let r = 0; r < 8; r++) {
    let files = 0
    for (const ch of ranks[r]!) {
      if (/[1-8]/.test(ch)) files += Number(ch)
      else if (/[pnbrqkPNBRQK]/.test(ch)) {
        files += 1
        count[ch] = (count[ch] ?? 0) + 1
        if ((ch === 'p' || ch === 'P') && (r === 0 || r === 7)) return 'FEN has a pawn on the first or last rank'
      } else return `FEN board has an invalid character "${ch}"`
    }
    if (files !== 8) return `FEN rank ${8 - r} describes ${files} files, expected 8`
  }
  if (count.K !== 1 || count.k !== 1) return 'FEN needs exactly one white king and one black king'
  for (const [side_, chars] of [['white', 'PNBRQK'], ['black', 'pnbrqk']] as const) {
    const total = [...chars].reduce((n, c) => n + (count[c] ?? 0), 0)
    if (total > 16) return `FEN has more than 16 ${side_} pieces`
    if ((count[chars[0]!] ?? 0) > 8) return `FEN has more than 8 ${side_} pawns`
  }
  if (side !== 'w' && side !== 'b') return `FEN side to move must be "w" or "b", got "${side}"`
  if (!/^(-|[KQkq]{1,4})$/.test(castling)) return `FEN castling field "${castling}" is invalid`
  if (!/^(-|[a-h][36])$/.test(ep)) return `FEN en-passant field "${ep}" is invalid`
  if (!/^\d+$/.test(half)) return 'FEN halfmove clock must be a non-negative integer'
  if (!/^[1-9]\d*$/.test(full)) return 'FEN fullmove number must be a positive integer'
  return null
}
