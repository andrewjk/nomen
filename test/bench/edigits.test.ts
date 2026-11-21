import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench, build_and_check_bench_args } from "./helpers";

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
