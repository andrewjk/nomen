import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// ==================== BigInt multi-limb division invariants ====================
// Knuth-D's q_hat machinery lives on tight invariants (normalization, the
// two-decrement bound, the D5 add-back), and div_to's D3/D4 share one
// materialized product — so correctness is pinned here by STRUCTURAL
// IDENTITIES over deterministic limb patterns chosen to hit the corners:
// a's top limb == b's top limb (div128's hi==d saturation), top limb 1
// (maximum normalization shift), interior zero / all-FF limbs, exact
// divisions, remainder == b-1, a < b, a == b. Every check is an identity
// (b*q + r == a and r < b against an independent recomputation), so the
// same program pins both backends without golden values.

const program = `
var uint64 rng = 88172645463325252

func next_u64 = (ref uint64 state, out uint64) {
	state = state * 6364136223846793005 + 1442695040888963407
	state = state ^ (state >> 33)
	return state
}

// x := the limb sequence drawn from rng, appended low-to-high. The top
// limb is drawn in [top_min, top_max] (or forced to force_top when it is
// nonzero); interior limbs occasionally become 0 or 2^64-1 to stress
// borrow chains across extreme limbs.
func build_limbs = (
	ref BigInt x { digits },
	int n_limbs,
	uint64 top_min,
	uint64 top_max,
	uint64 force_top,
	ref uint64 state,
	ref BigInt b_base,
	ref BigInt acc,
	ref BigInt s2,
	ref BigInt s3,
) {
	x.set_u64(0)
	var i = 0
	while i < n_limbs; i += 1 {
		var uint64 l = next_u64(ref state)
		if i == n_limbs - 1 && force_top != 0 {
			l = force_top
		}
		if i == n_limbs - 1 && force_top == 0 {
			const uint64 span = top_max - top_min + 1
			if span != 0 {
				l = top_min + (l % span)
			}
		}
		if i < n_limbs - 1 {
			const int p = ((l >> 40) & 15) as int
			if p == 3 {
				l = 0
			}
			if p == 9 {
				l = 18446744073709551615
			}
		}
		acc.mul_to(x, b_base, ref s2)
		s3.set_u64(l)
		acc.add_to(acc, s3)
		x.copy_from(acc)
	}
}

// check(a, b): divmod, then verify b*q + r == a and 0 <= r < b. Returns 1
// when both identities hold, 0 otherwise.
func check_pair = (
	ref BigInt a { digits },
	ref BigInt b { digits },
	ref BigInt s1 { digits },
	ref BigInt s2 { digits },
	ref BigInt s3 { digits },
	out int,
) {
	var BigInt q = BigInt()
	var BigInt r = BigInt()
	q.div_to(a, b, ref r)
	var BigInt bq = BigInt()
	bq.mul_to(b, q, ref s1)
	var BigInt back = BigInt()
	back.add_to(bq, r)
	var int ok = 0
	if back.cmp(a) == 0 {
		if r.cmp(b) < 0 {
			ok = 1
		}
	}
	return ok
}
var BigInt b_base = BigInt()
b_base.set_u64(4294967296)
var BigInt base_s = BigInt()
b_base.mul_to(b_base, b_base, ref base_s)

var BigInt one = BigInt()
one.set_int(1)

var BigInt s1 = BigInt()
var BigInt s2 = BigInt()
var BigInt s3 = BigInt()

var int total = 0
var int passed = 0

// ---- 10 random pairs, divisor 2..5 limbs, dividend 2..9 limbs ----
var t = 0
while t < 10; t += 1 {
	rng = next_u64(ref rng)
	var int n_b = 2 + ((rng & 3) as int)
	rng = next_u64(ref rng)
	var int n_a = n_b + ((rng & 7) as int)
	var BigInt a = BigInt()
	var BigInt b = BigInt()
	build_limbs(ref b, n_b, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	build_limbs(ref a, n_a, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	total += 1
	var int ok = check_pair(ref a, ref b, ref s1, ref s2, ref s3)
	passed += ok
}

// ---- 4 exact divisions: a = b*q, remainder must be zero ----
t = 0
while t < 4; t += 1 {
	rng = next_u64(ref rng)
	var int n_b = 2 + ((rng & 2) as int)
	rng = next_u64(ref rng)
	var int n_q = 3 + ((rng & 7) as int)
	var BigInt b = BigInt()
	var BigInt q0 = BigInt()
	build_limbs(ref b, n_b, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	build_limbs(ref q0, n_q, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	var BigInt a = BigInt()
	a.mul_to(b, q0, ref s1)
	total += 1
	var BigInt q = BigInt()
	var BigInt r = BigInt()
	q.div_to(a, b, ref r)
	var int ok = 0
	if q.cmp(q0) == 0 {
		if r.len == 1 && r.get(0) == 0 {
			ok = 1
		}
	}
	passed += ok
}

// ---- 3 divisions with remainder exactly b-1 ----
t = 0
while t < 3; t += 1 {
	rng = next_u64(ref rng)
	var int n_b = 2 + ((rng & 2) as int)
	rng = next_u64(ref rng)
	var int n_q = 2 + ((rng & 5) as int)
	var BigInt b = BigInt()
	var BigInt q0 = BigInt()
	build_limbs(ref b, n_b, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	build_limbs(ref q0, n_q, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	var BigInt bq = BigInt()
	bq.mul_to(b, q0, ref s1)
	var BigInt b1 = BigInt()
	b1.sub_to(b, one)
	var BigInt a = BigInt()
	a.add_to(bq, b1)
	total += 1
	var BigInt q = BigInt()
	var BigInt r = BigInt()
	q.div_to(a, b, ref r)
	var int ok = 0
	if q.cmp(q0) == 0 {
		if r.cmp(b1) == 0 {
			ok = 1
		}
	}
	passed += ok
}

// ---- a < b: quotient 0, remainder a ----
var BigInt bl = BigInt()
var BigInt al = BigInt()
build_limbs(ref bl, 4, 1000000000000000000, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
build_limbs(ref al, 2, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
total += 1
var BigInt ql = BigInt()
var BigInt rl = BigInt()
ql.div_to(al, bl, ref rl)
var int ok_l = 0
if ql.len == 1 && ql.get(0) == 0 {
	if rl.cmp(al) == 0 {
		ok_l = 1
	}
}
passed += ok_l

// ---- a == b: quotient 1, remainder 0 ----
var BigInt be = BigInt()
var BigInt ae = BigInt()
build_limbs(ref be, 3, 2, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
ae.copy_from(be)
total += 1
var BigInt qe = BigInt()
var BigInt re = BigInt()
qe.div_to(ae, be, ref re)
var int ok_e = 0
if qe.len == 1 && qe.get(0) == 1 {
	if re.len == 1 && re.get(0) == 0 {
		ok_e = 1
	}
}
passed += ok_e

// ---- 3 pairs with divisor's top limb 1 (maximum normalization shift) ----
t = 0
while t < 3; t += 1 {
	rng = next_u64(ref rng)
	var int n_b = 2 + ((rng & 2) as int)
	rng = next_u64(ref rng)
	var int n_a = n_b + ((rng & 5) as int)
	var BigInt a = BigInt()
	var BigInt b = BigInt()
	build_limbs(ref b, n_b, 1, 1, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	build_limbs(ref a, n_a, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	total += 1
	var int ok = check_pair(ref a, ref b, ref s1, ref s2, ref s3)
	passed += ok
}

// ---- 3 pairs whose dividend's top limb EQUALS the divisor's (div128's
// hi == d saturation corner) ----
t = 0
while t < 3; t += 1 {
	rng = next_u64(ref rng)
	var int n_b = 2 + ((rng & 2) as int)
	rng = next_u64(ref rng)
	var int n_a = n_b + ((rng & 3) as int)
	var BigInt b = BigInt()
	build_limbs(ref b, n_b, 1000000000000000000, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	var uint64 b_top = b.get(b.len - 1)
	var BigInt a = BigInt()
	build_limbs(ref a, n_a, 1, 18446744073709551615, b_top, ref rng, ref b_base, ref s1, ref s2, ref s3)
	total += 1
	var int ok = check_pair(ref a, ref b, ref s1, ref s2, ref s3)
	passed += ok
}

// ---- 2 wide pairs with interior 0 / all-FF limbs (long borrow chains) ----
t = 0
while t < 2; t += 1 {
	rng = next_u64(ref rng)
	var BigInt a = BigInt()
	var BigInt b = BigInt()
	build_limbs(ref b, 40, 1000000000000000000, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	build_limbs(ref a, 80, 1, 18446744073709551615, 0, ref rng, ref b_base, ref s1, ref s2, ref s3)
	total += 1
	var int ok = check_pair(ref a, ref b, ref s1, ref s2, ref s3)
	passed += ok
}

Console.write("total=")
Console.write(total.to_string())
Console.write(" passed=")
Console.write(passed.to_string())
Console.write("\\n")
`;

test("divrem invariants hold across limb-pattern corners (both backends)", async () => {
	// (js coverage of the shared non-C shape exists via the aarch64 run; the
	// JS backend's BigInt_mul_to runtime mapping has a pre-existing Number vs
	// BigInt defect unrelated to division, so js: true can't ride here yet.)
	await build_and_check_output(program, "bigint_divrem_invariants", "total=27 passed=27\n");
});
