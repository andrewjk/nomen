import type CompileError from "../src/types/CompileError.ts";

export default function test_error(
	source: string,
	message: string,
	line: number,
	column: number,
): CompileError {
	let start = 0;
	// The bound on `i` is load-bearing: the original loop condition was
	// `i < source.length, l < line` — the comma operator discards the first
	// operand, so the loop ran on `l < line` alone. A line number beyond the
	// source's line count (a wrong expectation in a test) never satisfied it
	// and spun the vitest worker forever with no output. Guard both.
	for (let i = 0, l = 1; i < source.length && l < line; i++) {
		if (source[i] === "\n") {
			start = i;
			l++;
		}
	}
	start += column;

	return {
		message,
		start,
		line,
		column,
	};
}
