import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/echo/binarytrees.echo", () => {
	test("parses without errors", () => {
		expect(parse_bench("binarytrees").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		const expected = [
			"stretch tree of depth 11\t check: 4095",
			"1024\t trees of depth 4\t check: 31744",
			"256\t trees of depth 6\t check: 32512",
			"64\t trees of depth 8\t check: 32704",
			"16\t trees of depth 10\t check: 32752",
			"long lived tree of depth 10\t check: 2047",
			"",
		].join("\n");
		await build_and_check_bench("binarytrees", expected);
	});
});
