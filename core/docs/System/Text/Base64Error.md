# Base64Error

## `enum Base64Error`

Why a base64 decode failed.

    match Base64.decode("Zm9v!") {
    	case .ok(bytes) -> Console.write(bytes)
    	case .fail(e) -> Console.write("bad base64")
    }

`invalid_length` — the input cannot be a whole number of base64 groups
(a padded input whose length is not a multiple of 4, or one stray
trailing character). `invalid_character(position)` — the byte at
`position` is not in the alphabet being decoded. `invalid_padding` — a
misplaced `=`, the wrong number of `=`, or non-zero bits in the final
character (a non-canonical encoding).
