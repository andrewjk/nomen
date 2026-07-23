import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/nomen/spectral-norm.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("spectral-norm").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("spectral-norm", "1.274220\n");
	});
});
