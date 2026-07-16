import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/echo/mandelbrot.echo", () => {
	test("parses without errors", () => {
		expect(parse_bench("mandelbrot").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("mandelbrot", "checksum 506926\n");
	});
});
