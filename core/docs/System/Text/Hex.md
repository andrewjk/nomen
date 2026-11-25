# Hex

## `struct Hex`

Hex (base16) encoding of bytes — lowercase `encode`, case-insensitive `decode`

    Console.write(Hex.encode("\xDE\xAD"))   // "dead"
    match Hex.decode("DEad") {
    	case .ok(bytes) -> Console.write("\{bytes.length}")   // 2
    	case .fail(e) -> Console.write("bad hex")
    }

Known gap: on the C and aarch64 backends a decoded value that contains a
0x00 byte is currently truncated at that byte (FOLLOWUP.md, "Native
string copies are not binary-safe").

**Members:**

- `encode(view string data) -> string`
- `decode(view string text) -> Result_string_HexError`
