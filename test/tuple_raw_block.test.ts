import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A tuple-returning free function whose body is a raw `#arch:` block (C source
// shared by the `c` backend and the `aarch64` companion via `aarch64_use_c`).
// The raw body references the auto-generated tuple struct by its TAG
// (`struct _Tuple_int_int`), which is unmangled on both backends — the mangled
// typedef (`nm__Tuple_int_int`) only exists in the aarch64 companion, so the
// tag is the portable form. Regression test for the gap that previously kept
// `Container.intrinsic_size` returning a single `int` per axis instead of an
// `[int, int]` tuple (see GUI.md).

describe("tuple-returning raw-block free function", () => {
	test("returns [int, int] from a #arch raw block on both backends", async () => {
		const input = `
import System

func dims = (int a, int b, out [int, int]) {
	\`\`\`
	#arch: c, aarch64_use_c
	#platform: macos
	struct _Tuple_int_int r;
	r._0 = a * 2;
	r._1 = b * 3;
	return r;
	\`\`\`
}

pub func main = () {
	var [w, h] = dims(4, 5)
	Console.write("\\{w} \\{h}")
}
`;
		await build_and_check_output(input, "tuple_raw_free_fn", "8 15", true);
	});

	test("tuple result is destructured and each field used", async () => {
		const input = `
import System

func dims = (int a, out [int, int]) {
	\`\`\`
	#arch: c, aarch64_use_c
	#platform: macos
	struct _Tuple_int_int r;
	r._0 = a + 1;
	r._1 = a + 2;
	return r;
	\`\`\`
}

pub func main = () {
	var [w, h] = dims(10)
	Console.write("\\{w} \\{h}")
}
`;
		await build_and_check_output(input, "tuple_raw_free_fn_destructure", "11 12", true);
	});
});
