# Base64

## `struct Base64`

Base64 encoding of bytes (RFC 4648) — standard (`encode`/`decode`) and URL-safe (`encode_url`/`decode_url`) alphabets

    Console.write(Base64.encode("foobar"))       // "Zm9vYmFy"
    Console.write(Base64.encode_url("\xFB\xFF"))  // "-_8" (no padding)
    match Base64.decode("Zm9vYg==") {
    	case .ok(bytes) -> Console.write(bytes)    // "foob"
    	case .fail(e) -> Console.write("bad base64")
    }

`encode` always pads to a multiple of four characters with `=`;
`decode` requires that padding. `encode_url` omits padding (the usual
form in URLs, JWTs and cookies); `decode_url` accepts input with or
without it.

Known gap: on the C and aarch64 backends a decoded value that contains a
0x00 byte is currently truncated at that byte when it is copied into the
result (FOLLOWUP.md, "Native string copies are not binary-safe").

**Members:**

- `encode(view string data) -> string`
- `encode_url(view string data) -> string`
- `decode(view string text) -> Result_string_Base64Error`
- `decode_url(view string text) -> Result_string_Base64Error`
