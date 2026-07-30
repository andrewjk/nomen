import { expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// ==================== new ====================

test("new: zero", async () => {
	const input = `
var BigInt a = BigInt()
a = a.new(0)
Console.write("sign=")
Console.write(a.sign.to_string())
Console.write(" len=")
Console.write(a.len.to_string())
Console.write(" digit=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_new_zero", "sign=1 len=1 digit=0");
});

test("new: positive", async () => {
	const input = `
var BigInt a = BigInt()
a = a.new(42)
Console.write("sign=")
Console.write(a.sign.to_string())
Console.write(" len=")
Console.write(a.len.to_string())
Console.write(" digit=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_new_positive", "sign=1 len=1 digit=42");
});

test("new: negative", async () => {
	const input = `
var BigInt a = BigInt()
a = a.new(-99)
Console.write("sign=")
Console.write(a.sign.to_string())
Console.write(" len=")
Console.write(a.len.to_string())
Console.write(" digit=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_new_negative", "sign=-1 len=1 digit=99");
});

// ==================== cmp ====================

test("cmp: equal", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(100)
b = b.new(100)
Console.write(a.cmp(b).to_string())
`;
	await build_and_check_output(input, "bigint_cmp_equal", "0");
});

test("cmp: less than", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(10)
b = b.new(20)
Console.write(a.cmp(b).to_string())
`;
	await build_and_check_output(input, "bigint_cmp_lt", "-1");
});

test("cmp: greater than", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(999)
b = b.new(1)
Console.write(a.cmp(b).to_string())
`;
	await build_and_check_output(input, "bigint_cmp_gt", "1");
});

test("cmp: different limb counts", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, ref s)
s = s.new(100)
Console.write("big=")
Console.write(a.cmp(s).to_string())
Console.write(" small=")
Console.write(s.cmp(a).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_cmp_diff_limbs", "big=1 small=-1");
});

// ==================== add_to ====================

test("add_to: single limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(30)
b = b.new(12)
a.add_to(a, b)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_add_single", "42");
});

test("add_to: carry produces second limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, ref s)
b = b.new(1)
a.add_to(a, b)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_add_carry", "len=2 l0=1 l1=1");
});

test("add_to: no overflow", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(500)
b = b.new(500)
a.add_to(a, b)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_add_overflow", "1000");
});

// ==================== sub_to ====================

test("sub_to: single limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(50)
b = b.new(18)
a.sub_to(a, b)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_sub_single", "32");
});

test("sub_to: result is zero", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(100)
b = b.new(100)
a.sub_to(a, b)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_sub_zero", "0");
});

test("sub_to: borrow across limbs", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, ref s)
b = b.new(1)
a.sub_to(a, b)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_sub_borrow", "len=1 l0=-1 l1=0");
});

// ==================== mul_to ====================

test("mul_to: single limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(7)
b = b.new(6)
a.mul_to(a, b, ref s)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_mul_single", "42");
});

test("mul_to: produces 2-limb result", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, ref s)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_mul_two_limb", "len=2 l0=0 l1=1");
});

test("mul_to: multi-limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, ref s)
b = b.new(1000000000)
s = s.new(1000000000)
b.mul_to(b, s, ref a)
s = s.new(1000000000)
b.mul_to(b, s, ref a)
Console.write(b.len.to_string())
`;
	await build_and_check_output(input, "bigint_mul_multi", "2");
});

// ==================== Karatsuba self-multiply (squaring) ====================

test("mul_to: Karatsuba self-multiply (a==b) at 32 limbs", async () => {
	const input = `
var BigInt ten = BigInt()
ten = ten.new(10)
var BigInt x = BigInt()
x = x.new(1)
var BigInt tmp = BigInt()
var BigInt scratch = BigInt()
var int i = 0
while i < 608 {
	tmp.mul_to(x, ten, ref scratch)
	x.copy_from(tmp)
	i = i + 1
}
var BigInt sq = BigInt()
sq.mul_to(x, x, ref scratch)
var BigInt y = BigInt()
y.copy_from(x)
var BigInt mu = BigInt()
mu.mul_to(x, y, ref scratch)
	Console.write("limbs=")
	Console.write(x.len.to_string())
	Console.write(" sq=")
	Console.write((sq.get(0) as int).to_string())
	Console.write(" cp=")
	Console.write((mu.get(0) as int).to_string())
	Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_karatsuba_self_mul", "limbs=32 sq=0 cp=0");
});

// ==================== div: single-limb ====================

test("div: single-limb exact", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(100)
b = b.new(10)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_single", "q=10 r=0");
});

test("div: single-limb with remainder", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(100)
b = b.new(7)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_single_rem", "q=14 r=2");
});

test("div: single-limb divisor=1", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(123456789)
b = b.new(1)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_single_divisor", "q=123456789 r=0");
});

test("div: dividend equals divisor", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(42)
b = b.new(42)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_dividend", "q=1 r=0");
});

test("div: dividend less than divisor", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(5)
b = b.new(10)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_dividend_less", "q=0 r=5");
});

// ==================== div: multi-limb Knuth D ====================

test("div: 2-limb / 1-limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, ref s)
b = b.new(3)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_two_one", "q=333333333333333333 r=1");
});

test("div: 2-limb / 2-limb exact", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
b = b.new(1000000000)
s = s.new(1000000000)
b.mul_to(b, s, ref rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, ref rem)
s = s.new(27)
a.mul_to(a, s, ref rem)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_two_two_exact", "q=27 r=0");
});

test("div: 2-limb / 2-limb with remainder", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
b = b.new(1000000000)
s = s.new(1000000000)
b.mul_to(b, s, ref rem)
s = s.new(3)
b.mul_to(b, s, ref rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, ref rem)
s = s.new(10)
a.mul_to(a, s, ref rem)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_two_two_remain", "q=3 r=1000000000000000000");
});

test("div: 2-limb / 2-limb carry test", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
b = b.new(-8006580162858909745)
s = s.new(4294967296)
var BigInt t = BigInt()
t = t.new(4294967296)
s.mul_to(s, t, ref rem)
t = t.new(444)
t.mul_to(t, s, ref rem)
b.add_to(b, t)
a = a.new(-8956217137030164580)
s = s.new(4294967296)
t = t.new(4294967296)
s.mul_to(s, t, ref rem)
t = t.new(12129)
t.mul_to(t, s, ref rem)
a.add_to(a, t)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_two_two_carry", "q=27");
});

// ==================== to_digit ====================

test("to_digit: single limb", async () => {
	const input = `
var BigInt a = BigInt()
a = a.new(42)
Console.write(a.to_digit().to_string())
`;
	await build_and_check_output(input, "bigint_to_digit_single", "42");
});

test("to_digit: multi-limb returns -1", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, ref s)
Console.write(a.to_digit().to_string())
`;
	await build_and_check_output(input, "bigint_to_multi", "-1");
});

// ==================== copy_from ====================

test("copy_from: creates independent copy", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(12345)
b.copy_from(a)
a = a.new(99999)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" b=")
Console.write((b.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_copy_independ", "a=99999 b=12345");
});

// ==================== mixed operation chains ====================

test("chain: mul then div roundtrip", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(12345)
b = b.new(67890)
a.mul_to(a, b, ref s)
b = b.new(67890)
q.div_to(a, b, ref rem)
Console.write("roundtrip=")
Console.write((q.get(0) as int).to_string())
Console.write(" rem=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_chain_mul_div", "roundtrip=12345 rem=0");
});

test("chain: add then sub roundtrip", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(1000)
b = b.new(42)
a.add_to(a, b)
b = b.new(42)
a.sub_to(a, b)
Console.write("roundtrip=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_chain_add_sub", "roundtrip=1000");
});

test("chain: mul then sub", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(100)
b = b.new(100)
a.mul_to(a, b, ref s)
b = b.new(1)
a.sub_to(a, b)
Console.write("100*100-1=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_chain_mul_sub", "100*100-1=9999");
});

test("chain: repeated mul", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(10)
b = b.new(10)
a.mul_to(a, b, ref s)
b = b.new(10)
a.mul_to(a, b, ref s)
Console.write("10^3=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_chain_mul_mul", "10^3=1000");
});

// ==================== edge cases ====================

test("edge: multiply by zero", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(999999)
b = b.new(0)
a.mul_to(a, b, ref s)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" val=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_edge_mul_zero", "len=1 val=0");
});

test("edge: multiply by one", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(123456789)
b = b.new(1)
a.mul_to(a, b, ref s)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_edge_mul_one", "123456789");
});

test("edge: add zero", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(42)
b = b.new(0)
a.add_to(a, b)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_edge_add_zero", "42");
});

test("edge: sub zero", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(42)
b = b.new(0)
a.sub_to(a, b)
Console.write((a.get(0) as int).to_string())
`;
	await build_and_check_output(input, "bigint_edge_sub_zero", "42");
});

// ==================== 3-limb operations ====================

test("mul: 3-limb result", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, ref s)
b = b.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, b, ref s)
b = b.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, b, ref s)
Console.write("len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_mul_three", "len=2");
});

test("div: 3-limb / 2-limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
b = b.new(1000000000)
s = s.new(1000000000)
b.mul_to(b, s, ref rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, ref rem)
s = s.new(1000000000)
a.mul_to(a, s, ref rem)
s = s.new(1000)
a.mul_to(a, s, ref rem)
q.div_to(a, b, ref rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_three_two", "q=1000000000000 r=0");
});

// ==================== pidigits-like division ====================

test("div: repeated div in loop (pidigits pattern)", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
var int i = 0
while i < 5 {
b = b.new(1000000000)
s = s.new(1000000000)
b.mul_to(b, s, ref rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, ref rem)
s = s.new(3)
a.mul_to(a, s, ref rem)
q.div_to(a, b, ref rem)
Console.write((q.get(0) as int).to_string())
Console.write(" ")
i = i + 1
}
Console.write("\\n")
`;
	await build_and_check_output(input, "bigint_div_repeated", "3 3 3 3 3");
});

// ==================== aliasing bugs (now caught at compile time) ====================

test("bug: mul_to scratch==a multi-limb clobbers a", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(1000000000)
b = b.new(3)
a.mul_to(a, b, ref a)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors[0].message).toContain("Aliasing");
});

test("bug: mul_to scratch==b multi-limb clobbers b", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(3)
b = b.new(1000000000)
a.mul_to(a, b, ref b)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors[0].message).toContain("Aliasing");
});

test("bug: mul_to scratch==self multi-limb zeroes result", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, ref a)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors[0].message).toContain("Aliasing");
});

test("bug: mul_to scratch==self single-limb zeroes result", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(42)
b = b.new(1000000000)
a.mul_to(a, b, ref a)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors[0].message).toContain("Aliasing");
});

test("bug: mul_to scratch==b with a.len==1 clobbers b", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(7)
b = b.new(1000000000)
a.mul_to(a, b, ref b)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors[0].message).toContain("Aliasing");
});

test("bug: mul_to scratch==a with b.len==1 clobbers a", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(1000000000)
b = b.new(7)
a.mul_to(a, b, ref a)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors.length).toBeGreaterThan(0);
	expect(parsed.errors[0].message).toContain("Aliasing");
});
