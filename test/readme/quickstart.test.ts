import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: quick start", () => {
	test("hello, world", () => {
		const input = `
pub func main = () {
    Console.write_line("Hello, World!")
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
