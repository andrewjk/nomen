import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// ==================== subquadratic BigInt paths ====================
// Sized to cross the measured gate in core/System/BigInt.nm:
//   TOOM3_MIN_LIMBS = 600 (both operands)
// Operands are built by salted squaring (limb count doubles per round), so
// construction stays fast. Every check is a structural identity (cmp against
// a recomputation), so correctness is pinned by the identities themselves on
// both backends.

// x: salt-grown base, then squared until past the target limb count.
const grow_to = (target: number, tag: string) => `
var BigInt ${tag} = BigInt(1000000000)
var BigInt salt_${tag} = BigInt()
salt_${tag}.set_u64(18446744073709551615)
var BigInt tmp_${tag} = BigInt()
var BigInt scratch_${tag} = BigInt()
var int i_${tag} = 0
while i_${tag} < 3; i_${tag} += 1 {
	tmp_${tag}.mul_to(${tag}, salt_${tag}, ref scratch_${tag})
	${tag}.copy_from(tmp_${tag})
}
while ${tag}.len < ${target}; i_${tag} += 1 {
	tmp_${tag}.mul_to(${tag}, ${tag}, ref scratch_${tag})
	${tag}.copy_from(tmp_${tag})
}
`;

describe("BigInt Toom-3 multiplication", () => {
	test("gate crossing: ~700-limb squaring identity (a+a)^2 == 4(a*a)", async () => {
		const input = `
${grow_to(600, "x")}
var BigInt scratch = BigInt()
var BigInt x2 = BigInt()
x2.add_to(x, x)
var BigInt sq1 = BigInt()
sq1.mul_to(x2, x2, ref scratch)
var BigInt sq2 = BigInt()
sq2.mul_to(x, x, ref scratch)
sq2.add_to(sq2, sq2)
sq2.add_to(sq2, sq2)
var int eq = 0
if sq1.cmp(sq2) == 0 {
	eq = 1
}
var int big = 0
if x.len >= 600 {
	big = 1
}
Console.write("big=")
Console.write(big.to_string())
Console.write(" eq=")
Console.write(eq.to_string())
Console.write("\\n")
`;
		await build_and_check_output(input, "bigint_toom_double", "big=1 eq=1\n");
	});

	test("identity: (a+b)*c == a*c + b*c at Toom-3 sizes", async () => {
		const input = `
${grow_to(600, "x")}
${grow_to(600, "y")}
var BigInt scratch = BigInt()
var BigInt ab = BigInt()
ab.add_to(x, y)
var BigInt left = BigInt()
left.mul_to(ab, y, ref scratch)
var BigInt ax = BigInt()
ax.mul_to(x, y, ref scratch)
var BigInt by = BigInt()
by.mul_to(y, y, ref scratch)
var BigInt right = BigInt()
right.add_to(ax, by)
var int eq = 0
if left.cmp(right) == 0 {
	eq = 1
}
Console.write("eq=")
Console.write(eq.to_string())
Console.write("\\n")
`;
		await build_and_check_output(input, "bigint_toom_distrib", "eq=1\n");
	});

	test("identity: a*(b+b) == a*b + a*b (cross-size shapes)", async () => {
		const input = `
${grow_to(900, "x")}
${grow_to(600, "y")}
var BigInt scratch = BigInt()
var BigInt y2 = BigInt()
y2.add_to(y, y)
var BigInt left = BigInt()
left.mul_to(x, y2, ref scratch)
var BigInt once = BigInt()
once.mul_to(x, y, ref scratch)
var BigInt right = BigInt()
right.add_to(once, once)
var int eq = 0
if left.cmp(right) == 0 {
	eq = 1
}
Console.write("eq=")
Console.write(eq.to_string())
Console.write("\\n")
`;
		await build_and_check_output(input, "bigint_toom_unbal", "eq=1\n");
	});

	test("below the Toom-3 gate: Karatsuba path still exact", async () => {
		const input = `
${grow_to(300, "x")}
var BigInt scratch = BigInt()
var BigInt x2 = BigInt()
x2.add_to(x, x)
var BigInt sq1 = BigInt()
sq1.mul_to(x2, x2, ref scratch)
var BigInt sq2 = BigInt()
sq2.mul_to(x, x, ref scratch)
sq2.add_to(sq2, sq2)
sq2.add_to(sq2, sq2)
var int eq = 0
if sq1.cmp(sq2) == 0 {
	eq = 1
}
Console.write("eq=")
Console.write(eq.to_string())
Console.write("\\n")
`;
		await build_and_check_output(input, "bigint_karatsuba_gate", "eq=1\n");
	});
});
