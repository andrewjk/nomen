import { describe, expect, test } from "vite-plus/test";

import { parse_raw } from "./parse_with_imports";
import test_error from "./test_error";

// A body mixing `#arch: aarch64_use_c` blocks with regular Nomen statements
// is a backend divergence, not a style question: the aarch64 backend routes
// the whole function to the C companion (the concatenation of the raw
// blocks, see check_c_fallback) and would silently drop the rest, while the
// C backend compiles it normally. Rejected at check time so the gap is
// never silent.

describe("mixed use_c bodies are rejected", () => {
	test("statements around a use_c block", () => {
		const input = `import System

func half_raw = (int x, out int) {
	\`\`\`
	#arch: c
	return x + 1;
	\`\`\`
	\`\`\`
	#arch: aarch64_use_c
	return x + 1;
	\`\`\`
	return x + 2
}
`;
		const parsed = parse_raw(input);
		const expected = [
			test_error(
				input,
				"Function 'half_raw' mixes '#arch: aarch64_use_c' blocks with Nomen statements — the aarch64 backend replaces the whole body with the raw blocks and would drop the statements",
				12,
				2,
			),
		];
		expect(parsed.errors).toEqual(expected);
	});

	test("inline asm around a use_c block", () => {
		const input = `import System

func both_raw = (int x, out int) {
	\`\`\`
	#arch: aarch64_use_c
	return x + 1;
	\`\`\`
	\`\`\`
	#arch: aarch64
	mov x0, x1
	\`\`\`
}
`;
		const parsed = parse_raw(input);
		const expected = [
			test_error(
				input,
				"Function 'both_raw' mixes '#arch: aarch64_use_c' blocks with inline raw code — the aarch64 backend replaces the whole body with the raw blocks and would drop the assembly",
				8,
				2,
			),
		];
		expect(parsed.errors).toEqual(expected);
	});

	test("parallel c + use_c implementations are fine", () => {
		const input = `import System

func parallel = (int x, out int) {
	\`\`\`
	#arch: c
	#platform: macos
	return x + 1;
	\`\`\`
	\`\`\`
	#arch: aarch64_use_c
	#platform: macos
	return x + 1;
	\`\`\`
	\`\`\`
	#arch: c
	#platform: ios
	return x + 2;
	\`\`\`
	\`\`\`
	#arch: aarch64_use_c
	#platform: ios
	return x + 2;
	\`\`\`
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	// A use_c block NESTED inside control flow is a different drop than the
	// whole-body replacement above: the body is emitted as assembly and
	// block-scope C has no inline splice, so the block itself never reaches
	// the companion (found building Window.run's resize stamping — the
	// stamping silently never ran on aarch64).
	test("nested use_c block inside an if", () => {
		const input = `import System

func nested_raw = (bool flag, out int) {
	var int n = 0
	if flag {
		\`\`\`
		#arch: c
		n = 1;
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		n = 1;
		\`\`\`
	}
	return n
}
`;
		const parsed = parse_raw(input);
		const expected = [
			test_error(
				input,
				"Function 'nested_raw' has a '#arch: aarch64_use_c' block nested inside control flow — the aarch64 backend emits the body as assembly and silently drops block-scope C; move the block into its own aarch64_use_c function and pass values as parameters",
				10,
				3,
			),
		];
		expect(parsed.errors).toEqual(expected);
	});

	// File-scope blocks are the blessed nested form: they hoist to the
	// companion's file scope and emit wherever the carrier function sits
	// (delegate IMPs, registries).
	test("nested file-scope block is allowed", () => {
		const input = `import System

func carrier = (bool flag) {
	if flag {
		\`\`\`
		#arch: c
		#scope: file
		static int nomen_counter = 0;
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#scope: file
		static int nomen_counter = 0;
		\`\`\`
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});
});
