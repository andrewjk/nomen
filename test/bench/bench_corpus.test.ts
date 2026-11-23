import { describe, expect, test } from "vite-plus/test";

import {
	build_and_check_bench,
	build_and_check_bench_args,
	build_and_check_bench_with_files,
	parse_bench,
} from "./helpers";

describe("bench/nomen/binarytrees.nm", () => {
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

describe("bench/nomen/edigits.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("edigits").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		const expected = ["2.718281828\t:10", "4590452353\t:20", "6028747\t:27", ""].join("\n");
		await build_and_check_bench("edigits", expected);
	});

	// A size large enough that `answer` crosses the divide-and-conquer radix
	// conversion's base case (answer.len > 7 limbs ≈ n > 135) and recurses —
	// the default-size run above only exercises the single-limb chain. The
	// expected digits below were verified digit-for-digit against the Go
	// reference (`big.Int.String`, whose decimal conversion the Nomen source
	// mirrors) via the pre-change implementation; the n=500 run recurses four
	// split levels deep and covers interior-leaf span padding.
	test("produces correct digits through the radix-conversion split path", async () => {
		const expected = [
			"2.718281828\t:10",
			"4590452353\t:20",
			"6028747135\t:30",
			"2662497757\t:40",
			"2470936999\t:50",
			"5957496696\t:60",
			"7627724076\t:70",
			"6303535475\t:80",
			"9457138217\t:90",
			"8525166427\t:100",
			"4274663919\t:110",
			"3200305992\t:120",
			"1817413596\t:130",
			"6290435729\t:140",
			"0033429526\t:150",
			"0595630738\t:160",
			"1323286279\t:170",
			"4349076323\t:180",
			"3829880753\t:190",
			"1952510190\t:200",
			"1157383418\t:210",
			"7930702154\t:220",
			"0891499348\t:230",
			"8416750924\t:240",
			"4761460668\t:250",
			"0822648001\t:260",
			"6847741185\t:270",
			"3742345442\t:280",
			"4371075390\t:290",
			"7774499206\t:300",
			"9551702761\t:310",
			"8386062613\t:320",
			"3138458300\t:330",
			"0752044933\t:340",
			"8265602976\t:350",
			"0673711320\t:360",
			"0709328709\t:370",
			"1274437470\t:380",
			"4723069697\t:390",
			"7209310141\t:400",
			"6928368190\t:410",
			"2551510865\t:420",
			"7463772111\t:430",
			"2523897844\t:440",
			"2505695369\t:450",
			"6770785449\t:460",
			"9699679468\t:470",
			"6445490598\t:480",
			"7931636889\t:490",
			"2300987931\t:500",
			"",
		].join("\n");
		await build_and_check_bench_args("edigits", expected, ["500"]);
	});
});

describe("bench/nomen/fannkuch-redux.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("fannkuch-redux").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("fannkuch-redux", "73196\nPfannkuchen(10) = 38\n");
	});
});

describe("bench/nomen/helloworld.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("helloworld").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("helloworld", "Hello world!\n");
	});
});

describe("bench/nomen/json-serde.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("json-serde").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench_with_files("json-serde", "691\n6910\n", {
			"sample.json": "bench/sample.json",
		});
	});
});

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

describe("bench/nomen/lru.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("lru").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("lru", "952\n9048\n");
	});
});

describe("bench/nomen/mandelbrot.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("mandelbrot").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("mandelbrot", "checksum 506926\n");
	});
});

describe("bench/nomen/merkletrees.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("merkletrees").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		const expected = [
			"stretch tree of depth 7\t root hash: 128 check: 1",
			"64\t trees of depth 4\t root hash sum: 1024",
			"16\t trees of depth 6\t root hash sum: 1024",
			"long lived tree of depth 6\t root hash: 64 check: 1",
			"",
		].join("\n");
		await build_and_check_bench("merkletrees", expected);
	});
});

describe("bench/nomen/nbody.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("nbody").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("nbody", "-0.169075\n-0.169088\n");
	});
});

describe("bench/nomen/nsieve.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("nsieve").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		const expected = [
			"Primes up to 160000 14683",
			"Primes up to 80000 7837",
			"Primes up to 40000 4203",
			"",
		].join("\n");
		await build_and_check_bench("nsieve", expected);
	});
});

describe("bench/nomen/pidigits.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("pidigits").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		// check_output compares only a prefix; pidigits prints 2000 digits
		// then "\t:2000". Verify the well-known opening of pi.
		await build_and_check_bench("pidigits", "31415926535897932384626433832795028841971693993751");
	});
});

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

describe("bench/nomen/spectral-norm.nm", () => {
	test("parses without errors", () => {
		expect(parse_bench("spectral-norm").errors).toEqual([]);
	});

	test("produces correct output on both backends", async () => {
		await build_and_check_bench("spectral-norm", "1.274220\n");
	});
});
