# HexError

## `enum HexError`

Why a hex decode failed.

`invalid_length` — the input has an odd number of digits.
`invalid_character(position)` — the byte at `position` is not `0-9`,
`a-f` or `A-F`.
