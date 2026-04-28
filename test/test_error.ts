import type CompileError from "../src/types/CompileError.ts";

export default function test_error(
	source: string,
	message: string,
	line: number,
	column: number,
): CompileError {
	let start = 0;
	for (let i = 0, l = 1; i < source.length, l < line; i++) {
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
