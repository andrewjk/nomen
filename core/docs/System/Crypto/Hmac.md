# Hmac

## `struct Hmac`

HMAC-SHA256 message authentication — incremental (`update`/`finish`) or one-shot `Hmac.sha256(key, message)`

    const tag = Hmac.sha256("key", "The quick brown fox jumps over the lazy dog")
    Console.write(Hex.encode(tag))   // "f7bc83f4…b9d8"

    var mac = Hmac("key")
    mac.update("The quick brown fox ")
    mac.update("jumps over the lazy dog")
    const same = mac.finish()

Keys and tags are raw bytes in a `string`. Keys longer than the 64-byte
block are hashed first, as the standard requires. `finish` returns the
32-byte tag and re-arms the instance for another message under the same
key.

**Members:**

- `update(view string data)`
- `finish() -> string`
- `sha256(view string key, view string message) -> string`
