import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/nomen/lru.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("lru").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("lru", "952\n9048\n");
	});
});
