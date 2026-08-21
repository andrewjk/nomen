import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench_with_files } from "./helpers";

describe("bench/nomen/knucleotide.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("knucleotide").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		// The default input (25000_in) has no >THREE header, so the sequence
		// extraction yields an empty dataset and every k-mer count is zero.
		await build_and_check_bench_with_files(
			"knucleotide",
			"\n\n0\tGGT\n0\tGGTA\n0\tGGTATT\n0\tGGTATTTTAATT\n0\tGGTATTTTAATTTATAGT\n",
			{ "25000_in": "25000_in" },
		);
	});

	test("exercises the >THREE data path on both backends", async () => {
		// knucleotide_input.txt has a >THREE header, so the read loop stores
		// real bases (running the inlined base_code return inside the loop)
		// and the k-mer counting/sorting runs on actual data. It is staged as
		// 25000_in — the binary's default input name.
		await build_and_check_bench_with_files(
			"knucleotide",
			[
				"G 27.684",
				"A 24.584",
				"T 24.343",
				"C 23.389",
				"",
				"GA 8.353",
				"GG 8.114",
				"AG 7.877",
				"TT 6.683",
				"CG 6.682",
				"TC 6.444",
				"TA 6.205",
				"AT 5.967",
				"AC 5.967",
				"CT 5.966",
				"GT 5.727",
				"CC 5.490",
				"GC 5.489",
				"CA 5.252",
				"TG 5.012",
				"AA 4.773",
				"",
				"4175\tGGT",
				"596\tGGTA",
				"0\tGGTATT",
				"0\tGGTATTTTAATT",
				"0\tGGTATTTTAATTTATAGT",
				"",
			].join("\n"),
			{ "knucleotide_input.txt": "25000_in" },
			"full",
		);
	});
});
