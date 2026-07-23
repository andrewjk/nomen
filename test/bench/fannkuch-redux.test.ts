import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/nomen/fannkuch-redux.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("fannkuch-redux").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("fannkuch-redux", "73196\nPfannkuchen(10) = 38\n");
	});
});
