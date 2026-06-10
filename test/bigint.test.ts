import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_new_zero", result, "sign=1 len=1 digit=0");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_new_positive", result, "sign=1 len=1 digit=42");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_new_negative", result, "sign=-1 len=1 digit=99");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_cmp_equal", result, "0");
});

test("cmp: less than", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(10)
b = b.new(20)
Console.write(a.cmp(b).to_string())
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_cmp_lt", result, "-1");
});

test("cmp: greater than", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(999)
b = b.new(1)
Console.write(a.cmp(b).to_string())
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_cmp_gt", result, "1");
});

test("cmp: different limb counts", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, s)
s = s.new(100)
Console.write("big=")
Console.write(a.cmp(s).to_string())
Console.write(" small=")
Console.write(s.cmp(a).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_cmp_diff_limbs", result, "big=1 small=-1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_add_single", result, "42");
});

test("add_to: carry produces second limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, s)
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_add_carry", result, "len=2 l0=1 l1=1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_add_overflow", result, "1000");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_sub_single", result, "32");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_sub_zero", result, "0");
});

test("sub_to: borrow across limbs", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, s)
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_sub_borrow", result, "len=1 l0=-1 l1=0");
});

// ==================== mul_to ====================

test("mul_to: single limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(7)
b = b.new(6)
a.mul_to(a, b, s)
Console.write((a.get(0) as int).to_string())
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_mul_single", result, "42");
});

test("mul_to: produces 2-limb result", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, s)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_mul_two_limb", result, "len=2 l0=0 l1=1");
});

test("mul_to: multi-limb", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, s)
b = b.new(1000000000)
s = s.new(1000000000)
b.mul_to(b, s, a)
s = s.new(1000000000)
b.mul_to(b, s, a)
Console.write(b.len.to_string())
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_mul_multi", result, "2");
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
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_single", result, "q=10 r=0");
});

test("div: single-limb with remainder", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(100)
b = b.new(7)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_single_rem", result, "q=14 r=2");
});

test("div: single-limb divisor=1", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(123456789)
b = b.new(1)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_single_divisor", result, "q=123456789 r=0");
});

test("div: dividend equals divisor", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(42)
b = b.new(42)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_dividend", result, "q=1 r=0");
});

test("div: dividend less than divisor", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt q = BigInt()
var BigInt rem = BigInt()
a = a.new(5)
b = b.new(10)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_dividend_less", result, "q=0 r=5");
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
a.mul_to(a, b, s)
b = b.new(3)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_two_one", result, "q=333333333333333333 r=1");
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
b.mul_to(b, s, rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, rem)
s = s.new(27)
a.mul_to(a, s, rem)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_two_two_exact", result, "q=27 r=0");
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
b.mul_to(b, s, rem)
s = s.new(3)
b.mul_to(b, s, rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, rem)
s = s.new(10)
a.mul_to(a, s, rem)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_two_two_remain", result, "q=3 r=1000000000000000000");
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
s.mul_to(s, t, rem)
t = t.new(444)
t.mul_to(t, s, rem)
b.add_to(b, t)
a = a.new(-8956217137030164580)
s = s.new(4294967296)
t = t.new(4294967296)
s.mul_to(s, t, rem)
t = t.new(12129)
t.mul_to(t, s, rem)
a.add_to(a, t)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_two_two_carry", result, "q=27");
});

// ==================== to_digit ====================

test("to_digit: single limb", async () => {
	const input = `
var BigInt a = BigInt()
a = a.new(42)
Console.write(a.to_digit().to_string())
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_to_digit_single", result, "42");
});

test("to_digit: multi-limb returns -1", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(4294967296)
b = b.new(4294967296)
a.mul_to(a, b, s)
Console.write(a.to_digit().to_string())
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_to_multi", result, "-1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_copy_independ", result, "a=99999 b=12345");
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
a.mul_to(a, b, s)
b = b.new(67890)
q = q.div(a, b, rem)
Console.write("roundtrip=")
Console.write((q.get(0) as int).to_string())
Console.write(" rem=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_chain_mul_div", result, "roundtrip=12345 rem=0");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_chain_add_sub", result, "roundtrip=1000");
});

test("chain: mul then sub", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(100)
b = b.new(100)
a.mul_to(a, b, s)
b = b.new(1)
a.sub_to(a, b)
Console.write("100*100-1=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_chain_mul_sub", result, "100*100-1=9999");
});

test("chain: repeated mul", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(10)
b = b.new(10)
a.mul_to(a, b, s)
b = b.new(10)
a.mul_to(a, b, s)
Console.write("10^3=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_chain_mul_mul", result, "10^3=1000");
});

// ==================== edge cases ====================

test("edge: multiply by zero", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(999999)
b = b.new(0)
a.mul_to(a, b, s)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" val=")
Console.write((a.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_edge_mul_zero", result, "len=1 val=0");
});

test("edge: multiply by one", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(123456789)
b = b.new(1)
a.mul_to(a, b, s)
Console.write((a.get(0) as int).to_string())
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_edge_mul_one", result, "123456789");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_edge_add_zero", result, "42");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_edge_sub_zero", result, "42");
});

// ==================== 3-limb operations ====================

test("mul: 3-limb result", async () => {
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
var BigInt s = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, s)
b = b.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, b, s)
b = b.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, b, s)
Console.write("len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_mul_three", result, "len=2");
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
b.mul_to(b, s, rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, rem)
s = s.new(1000000000)
a.mul_to(a, s, rem)
s = s.new(1000)
a.mul_to(a, s, rem)
q = q.div(a, b, rem)
Console.write("q=")
Console.write((q.get(0) as int).to_string())
Console.write(" r=")
Console.write((rem.get(0) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_three_two", result, "q=1000000000000 r=0");
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
b.mul_to(b, s, rem)
a = a.new(1000000000)
s = s.new(1000000000)
a.mul_to(a, s, rem)
s = s.new(3)
a.mul_to(a, s, rem)
q = q.div(a, b, rem)
Console.write((q.get(0) as int).to_string())
Console.write(" ")
i = i + 1
}
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_div_repeated", result, "3 3 3 3 3");
});

// ==================== known aliasing bugs ====================

test("bug: mul_to scratch==a multi-limb clobbers a", async () => {
	// scratch.clear(new_len) zeroes a's digits before schoolbook reads them
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(1000000000)
b = b.new(3)
a.mul_to(a, b, a)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_bug_one", result, "a=3000000000 a.len=1");
});

test("bug: mul_to scratch==b multi-limb clobbers b", async () => {
	// scratch.clear(new_len) zeroes b's digits before schoolbook reads them
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(3)
b = b.new(1000000000)
a.mul_to(a, b, b)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_bug_two", result, "a=3000000000 a.len=1");
});

test("bug: mul_to scratch==self multi-limb zeroes result", async () => {
	// self.clear(new_len) zeroes scratch (=self) after schoolbook loop
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(1000000000)
b = b.new(1000000000)
a.mul_to(a, b, a)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_bug_three", result, "len=2 l0=0 l1=1");
});

test("bug: mul_to scratch==self single-limb zeroes result", async () => {
	// self.clear(other_len+1) zeroes scratch (=self) after copying multi-limb into it
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(42)
b = b.new(1000000000)
a.mul_to(a, b, a)
Console.write("len=")
Console.write(a.len.to_string())
Console.write(" l0=")
Console.write((a.get(0) as int).to_string())
Console.write(" l1=")
Console.write((a.get(1) as int).to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_bug_four", result, "len=1 l0=42000000000 l1=0");
});

test("bug: mul_to scratch==b with a.len==1 clobbers b", async () => {
	// scratch.clear(b.len) zeroes b, then copy loop reads zeros
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(7)
b = b.new(1000000000)
a.mul_to(a, b, b)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_bug_five", result, "a=7000000000 a.len=1");
});

test("bug: mul_to scratch==a with b.len==1 clobbers a", async () => {
	// scratch.clear(a.len) zeroes a, then copy loop reads zeros
	const input = `
var BigInt a = BigInt()
var BigInt b = BigInt()
a = a.new(1000000000)
b = b.new(7)
a.mul_to(a, b, a)
Console.write("a=")
Console.write((a.get(0) as int).to_string())
Console.write(" a.len=")
Console.write(a.len.to_string())
Console.write("\\n")
`;
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(parsed.errors).toEqual([]);
	await check_output("bigint_bug_six", result, "a=7000000000 a.len=1");
});
