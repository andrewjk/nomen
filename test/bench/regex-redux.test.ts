import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench_with_files } from "./helpers";

describe("bench/nomen/regex-redux.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("regex-redux").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		const expected = [
			"agggtaaa|tttaccct 2",
			"[cgt]gggtaaa|tttaccc[acg] 1",
			"a[act]ggtaaa|tttacc[agt]t 1",
			"ag[act]gtaaa|tttac[agt]ct 1",
			"agg[act]taaa|ttta[agt]cct 1",
			"aggg[acg]aaa|ttt[cgt]ccct 4",
			"agggt[cgt]aa|tt[acg]accct 0",
			"agggta[cgt]a|t[acg]taccct 5",
			"agggtaa[cgt]|[acg]ttaccct 2",
			"",
			"25447",
			"25000",
			"11705",
			"",
		].join("\n");
		await build_and_check_bench_with_files("regex-redux", expected, {
			"25000_in": "25000_in",
		});
	});
});
