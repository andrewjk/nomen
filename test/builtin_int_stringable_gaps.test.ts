import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/**
 * Stringable gaps (same class as the uint32 split-link gap): core defined
 * primitive structs for `int8`/`uint8`/`int64`/`uint64`/`uint32` (etc.) with
 * raw `to_string` bodies, but had no `int16.nm`, `uint16.nm`, or `int32.nm` —
 * so interpolation of those types emitted a call to `int16_to_string` (etc.)
 * that existed nowhere and failed to link. Fixed by adding the three `.nm`
 * files (Stringable/Hashable/Equatable with snprintf bodies), following the
 * `int8.nm`/`uint8.nm`/`uint32.nm` templates.
 */

test("int16/uint16/int32 interpolate via Stringable (both backends)", async () => {
	const input = `
import System

pub func main = () {
	var int16 a = -12345
	var uint16 b = 65535
	var int32 c = -2000000000
	Console.write("\\{a} \\{b} \\{c}\\n")
}
`;
	await build_and_check_output(
		input,
		"builtin_int16_uint16_int32_to_string",
		"-12345 65535 -2000000000\n",
		true,
	);
});
