import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Random — the splitmix64 generator in core/System/Random.nm. The raw
// sequence is fully determined by the seed, so the expected values are
// computed here (BigInt splitmix64) and asserted exactly, on both backends.

const M64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const C1 = 0xbf58476d1ce4e5b9n;
const C2 = 0x94d049bb133111ebn;

/** One splitmix64 step: returns the new state and the emitted value. */
function next(state: bigint): [bigint, bigint] {
	const s = (state + GOLDEN) & M64;
	let z = s;
	z = ((z ^ (z >> 30n)) * C1) & M64;
	z = ((z ^ (z >> 27n)) * C2) & M64;
	return [s, (z ^ (z >> 31n)) & M64];
}

function seq(seed: bigint, count: number): bigint[] {
	const out: bigint[] = [];
	let s = seed;
	for (let i = 0; i < count; i++) {
		const [ns, v] = next(s);
		s = ns;
		out.push(v);
	}
	return out;
}

describe("Random (splitmix64)", () => {
	test("next() matches the splitmix64 reference sequence", async () => {
		const expected = seq(42n, 4);
		const input = `
var Random rng = Random(42)
Console.write("\\{rng.next()}")
Console.write(",")
Console.write("\\{rng.next()}")
Console.write(",")
Console.write("\\{rng.next()}")
Console.write(",")
Console.write("\\{rng.next()}")
`;
		const expected_text = expected.join(",");
		await build_and_check_output(input, "random_next", expected_text);
	});

	test("below() stays in [0, bound) and matches next() % bound", async () => {
		const values = seq(7n, 8);
		const bound = 100n;
		const expected = values.map((v) => (v % bound).toString()).join(",");
		const input = `
var Random rng = Random(7)
var uint64 i = 0
while i < 8 {
	if i > 0 {
		Console.write(",")
	}
	Console.write("\\{rng.below(100)}")
	i += 1
}
`;
		await build_and_check_output(input, "random_below", expected);
	});

	test("range() stays in [lo, hi] inclusive", async () => {
		const values = seq(9n, 6);
		const lo = 1000n;
		const hi = 10000n;
		const expected = values.map((v) => (lo + (v % (hi - lo + 1n))).toString()).join(",");
		const input = `
var Random rng = Random(9)
var uint64 i = 0
while i < 6 {
	if i > 0 {
		Console.write(",")
	}
	Console.write("\\{rng.range(1000, 10000)}")
	i += 1
}
`;
		await build_and_check_output(input, "random_range", expected);
	});
});
