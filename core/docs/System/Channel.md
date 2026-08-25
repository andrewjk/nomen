# Channel

## `class Channel`

A thread-safe, blocking FIFO queue for passing values between tasks

**Members:**

- `send(uint64 value)`
- `send_string(string value)`
- `receive() -> uint64`
- `receive_string() -> string`
