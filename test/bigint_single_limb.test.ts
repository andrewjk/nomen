import { test } from "vite-plus/test";

/**
 * Tranche E: the single-limb div_to path divides by invariant
 * multiplication (Granlund–Montgomery reciprocal hoisted per call, umulh
 * estimate + self-validating remainder correction). This sweep drives
 * every divisor class (powers of two around 2^32/2^63, max limb, values
 * needing every normalization shift) × dividend limb patterns through
 * div_to on BOTH backends and verifies a == q*d + r inside the program —
 * the C backend's __int128 body is the independent oracle for the new
 * aarch64 path.
 */

test("behavioral: single-limb division sweep matches on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	await build_and_check_output(
		`
import System

func emit_limb = (ref BigInt a, ref BigInt p64, ref BigInt scratch, uint64 hi, uint64 m1, uint64 m2, uint64 lo) {
	var limb = BigInt()
	a.set_u64(hi)
	a.mul_to(a, p64, ref scratch)
	limb.set_u64(m1)
	a.add_to(a, limb)
	a.mul_to(a, p64, ref scratch)
	limb.set_u64(m2)
	a.add_to(a, limb)
	a.mul_to(a, p64, ref scratch)
	limb.set_u64(lo)
	a.add_to(a, limb)
}

pub func main = () {
	var t = BigInt()
	var rem = BigInt()
	var prod = BigInt()
	var scratch = BigInt()
	var a = BigInt()
	var d = BigInt()
	var two = BigInt()
	var p64 = BigInt()
	var limb = BigInt()
	two.set_u64(2)
	p64.set_u64(1)
	var k = 0
	while k < 64; k += 1 {
		p64.mul_to(p64, two, ref scratch)
	}
	var uint64 max = 18446744073709551615

	var count = 0
	var bad = 0
	var di = 0
	while di < 16; di += 1 {
		if di == 0 { d.set_u64(1) }
		if di == 1 { d.set_u64(2) }
		if di == 2 { d.set_u64(3) }
		if di == 3 { d.set_u64(2147483647) }
		if di == 4 { d.set_u64(2147483648) }
		if di == 5 { d.set_u64(4294967295) }
		if di == 6 { d.set_u64(4294967296) }
		if di == 7 { d.set_u64(4294967311) }
		if di == 8 { d.set_u64(1125899906842624) }
		if di == 9 { d.set_u64(9223372036854775807) }
		if di == 10 { d.set_u64(9223372036854775808) }
		if di == 11 { d.set_u64(9223372036854775809) }
		if di == 12 { d.set_u64(13835058055282163712) }
		if di == 13 { d.set_u64(18446744073709551613) }
		if di == 14 { d.set_u64(18446744073709551614) }
		if di == 15 { d.set_u64(18446744073709551615) }

		var pi = 0
		while pi < 11; pi += 1 {
			if pi == 0 { emit_limb(ref a, ref p64, ref scratch, 0, 0, 0, 0) }
			if pi == 1 { emit_limb(ref a, ref p64, ref scratch, 0, 0, 0, 1) }
			if pi == 2 { emit_limb(ref a, ref p64, ref scratch, 0, 0, 0, max) }
			if pi == 3 { emit_limb(ref a, ref p64, ref scratch, 1, 0, 0, 0) }
			if pi == 4 { emit_limb(ref a, ref p64, ref scratch, max, max, max, max) }
			if pi == 5 { emit_limb(ref a, ref p64, ref scratch, 1, 2, 3, 4) }
			if pi == 6 { emit_limb(ref a, ref p64, ref scratch, max, 0, max, 0) }
			if pi == 7 { emit_limb(ref a, ref p64, ref scratch, 3, 1, 4, 1) }
			if pi == 8 { emit_limb(ref a, ref p64, ref scratch, 7, 7, 7, 7) }
			if pi == 9 { emit_limb(ref a, ref p64, ref scratch, 0, max, 0, max) }
			if pi == 10 { emit_limb(ref a, ref p64, ref scratch, 18446744073709551614, max, 0, 5) }

			t.div_to(a, d, ref rem)
			prod.mul_to(t, d, ref scratch)
			prod.add_to(prod, rem)
			count += 1
			if a.cmp(prod) != 0 {
				bad += 1
			}
			if rem.cmp(d) >= 0 {
				bad += 1
			}
		}
	}
	Console.write("count \\{count} bad \\{bad}\\n")
}
`,
		"bigint_single_limb_sweep",
		"count 176 bad 0",
		true,
	);
});
