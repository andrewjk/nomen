import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/**
 * Split-build link gap (pre-existing): a user program monomorphizing
 * `Buffer<uint32>` failed to link. Two halves:
 *
 * - The user TU correctly emits `Buffer_uint32_*` itself (the canonical
 *   system.o never instantiates that generic), but its interpolation of
 *   `b.load(3)` calls `uint32_to_string` — which existed NOWHERE: core
 *   defines `uint8`/`uint`/`uint64` (etc.) primitive structs with raw
 *   `to_string` bodies, but had no `uint32.nm`, so even a single-TU build
 *   left `bl uint32_to_string` undefined.
 * - Fixed by adding `core/System/uint32.nm` (Stringable/Hashable/Equatable
 *   with `%u` snprintf bodies), following the `uint8.nm` template.
 */

test("Buffer<uint32> splits, links, and runs (both backends)", async () => {
	const input = `
import System

pub func main = () {
	var Buffer<uint32> b = Buffer<uint32>()
	b.alloc(4)
	var i = 0
	while i < 4; i += 1 {
		b.store(i, (i * 7) as uint32)
	}
	Console.write("\\{b.load(3)}\\n")
	Console.write("\\{b.load(0)}\\n")
}
`;
	await build_and_check_output(input, "buffer_uint32_split", "21\n0\n", true);
});
