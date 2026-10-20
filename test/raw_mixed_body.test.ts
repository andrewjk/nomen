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
});
