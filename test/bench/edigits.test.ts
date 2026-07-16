import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/echo/edigits.echo", () => {
	test("parses without errors", () => {
		expect(parse_bench("edigits").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		const expected = ["2.718281828\t:10", "4590452353\t:20", "6028747\t:27", ""].join("\n");
		await build_and_check_bench("edigits", expected);
	});
});
