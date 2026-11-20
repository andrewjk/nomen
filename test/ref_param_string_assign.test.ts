import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Assigning an owned string through a `ref` parameter LEAKED the displaced
// pair: the callee sees only `nomen_string *` and neither freed the old
// value nor transferred it (the FOLLOWUP repro — the serde decoder assigning
// `target = Json.deserialize(...)` through `ref p.name` leaked one
// allocation per call). The fix is at the CALL SITE: the caller knows the
// slot's ownership, so a vouched slot captures the old pair before the call
// and frees it after (a C statement-expression / aarch64 frame temp), and
// slots that hold borrowed or rodata bytes adopt the new value instead
// (recorded heap-owned so scope exit releases it). Both backends run these
// binaries under the audit harness — every displaced pair must balance.

test("ref param -- owned string assigned through a field ref (the serde shape)", async () => {
	const input = `
mv struct Person {
	mv string name = ""
}

func assign_it<T> = (ref T target) {
	target = Json.deserialize("\\"Ada\\"")
}

var p = Person()

json_decode_into("{\\"x\\":1}", ref p)
assign_it(ref p.name)
Console.write_line(p.name)
assign_it(ref p.name)
Console.write_line(p.name)
`;
	await build_and_check_output(input, "ref_param_field_assign", "Ada\nAda\n");
});

test("ref param -- owned string assigned through a local ref", async () => {
	const input = `
func assign_owned<T> = (ref T target) {
	target = "owned-value".copy()
}

var name = ""
assign_owned(ref name)
Console.write_line(name)
assign_owned(ref name)
Console.write_line(name)
`;
	await build_and_check_output(input, "ref_param_local_assign", "owned-value\nowned-value\n");
});

test("ref param -- repeated assignment through a ref in a loop stays balanced", async () => {
	const input = `
func replace<T> = (ref T target) {
	target = "x".copy()
}

var s = "seed"
var int i = 0
while i < 5; i += 1 {
	replace(ref s)
}
Console.write_line(s)
`;
	// Audit on: the literal-initialized slot holds RODATA on iteration 1
	// (its displaced pair must not be freed) and the callee's stored heap
	// pair from iteration 2 on (must be freed). A static record can't see
	// iterations, so the slot carries a runtime owns-flag (set by the first
	// definite store through the ref param); every displaced free and the
	// scope-exit free guard on it — the loop-displaced-rodata leak.
	await build_and_check_output(input, "ref_param_loop_assign", "x\n");
});

test("ref param -- concat read through a ref param keeps both halves", async () => {
	const input = `
func bump<T> = (ref T target) {
	target = target + "x"
}

var s = "seed"
bump(ref s)
bump(ref s)
Console.write_line(s)
`;
	// `target = target + "x"`: the left operand is a `ref string` deref.
	// aarch64 loaded only the ptr half, leaving the len register holding the
	// right operand's length — "seed" became "s", so every bump produced
	// "sx" instead of appending to the full value.
	await build_and_check_output(input, "ref_param_concat", "seedxx\n");
});

test("ref param -- a may-store callee that never stores leaves the slot intact", async () => {
	const input = `
func maybe_set<T> = (ref T target, bool doit) {
	if doit {
		target = "w".copy()
	}
}

var s = "seed"
maybe_set(ref s, false)
Console.write_line(s)
`;
	// The conditional store is a MAY-write: the callee may leave the slot's
	// original pair in place. The call-site capture must not treat the slot
	// as heap-owned afterwards (aarch64's adopts-record / C's re-registered
	// scope-exit free used to reclaim the still-live value — audit
	// stale-free). Only a definite wholesale store vouches ownership.
	await build_and_check_output(input, "ref_param_may_store", "seed\n");
});

test("ref param -- a may-store callee that stores leaks the new value (bounded)", async () => {
	const input = `
func maybe_set<T> = (ref T target, bool doit) {
	if doit {
		target = "w".copy()
	}
}

var s = "seed"
maybe_set(ref s, true)
Console.write_line(s)
`;
	// The store path of the pair above. The slot cannot be vouched heap-owned
	// (the store is conditional), so the callee's stored copy has no owner to
	// reclaim it: one allocation per such call leaks. That is the deliberate
	// posture — the alternative (vouching the slot heap) frees the rodata
	// pair when the store is skipped, i.e. an invalid free. Audit off for the
	// documented bounded leak; the output is correct on both backends.
	await build_and_check_output(input, "ref_param_may_store_yes", "w\n", false, {
		audit: false,
	});
});

test("ref param -- ref string plumbing checks clean", () => {
	const input = `
mv struct Person {
	mv string name = ""
}

func assign_it<T> = (ref T target) {
	target = Json.deserialize("\\"Ada\\"")
}

var p = Person()
assign_it(ref p.name)
var local = ""
assign_it(ref local)
Console.write_line(p.name + " " + local)
`;
	expect(parse_with_imports(input).errors).toEqual([]);
});

test("ref param -- ref string takes ONE ABI slot (trailing params read their own)", async () => {
	// `ref string` arrives as one &slot pointer, not a fat (ptr, len) pair.
	// The callee's param walk used to count it as a pair, so every trailing
	// param read one register too high (garbage) — the shape the by-ref
	// json_encode walk exposed (its `ref T value` first param, `ref
	// StringBuilder sb` second). Both trailing shapes are pinned: scalars
	// and a callee-saved struct param.
	const input = `
func add_into = (ref string r, int n, int m, ref int got) {
	got = r.length + n * m
}

func stitch = (ref string r, ref StringBuilder sb {}, ref string dst) {
	sb.append_string(r)
	sb.append_string("!")
	dst = sb.to_string()
}

var r = "abcd"
var int got = 0
add_into(ref r, 3, 5, ref got)
Console.write_line(got.to_string())
var sb = StringBuilder()
var result = ""
stitch(ref r, ref sb, ref result)
Console.write_line(result)
`;
	await build_and_check_output(input, "ref_string_trailing_params", "19\nabcd!\n");
});

test("ref param -- a ref-string call in VALUE position builds and stays balanced", async () => {
	// The C backend wraps such a call in a GNU statement expression (the
	// displaced-pair reclaim), and used to close it right after the final
	// expression — no semicolon — so clang rejected every value-position
	// use ("expected ';' after expression"): a declaration initializer, an
	// interpolation argument, an operation operand. Statement-position
	// calls were unaffected (a plain call, no wrapper). Pin the value
	// shapes; the audit harness proves the capture stays balanced.
	const input = `
func f = (ref string r, int n, out int) {
	return r.length + n
}

var s = "abcd"
Console.write_line(f(ref s, 3).to_string())
var x = f(ref s, 3)
Console.write_line(x.to_string())
Console.write_line(s)
`;
	await build_and_check_output(input, "ref_string_value_position", "7\n7\nabcd\n");
});
