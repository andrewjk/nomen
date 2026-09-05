import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_slp_pair_enabled } from "../src/build_aarch64/slp_pair";
import { get_library } from "../src/lib";
import parse from "../src/parse";

const system_lib = get_library(path.resolve("core"));

/**
 * Field-pair SLP (ASM_PLAN_4 remaining step 1): adjacent same-shaped
 * float statements over ADJACENT 8-byte fields of one fixed-array
 * element lower as `.2d` lane pairs — `ldur q`/`stur q` field access,
 * `f{add,sub,mul}.2d` chains with scalar broadcasts, and the `faddp`
 * square-sum reduction in the float-tree builder. The pass consumes two
 * statements per fuse and plans lane pairs (a in dN, b in vN.d[1],
 * slot-synced) in both allocators.
 *
 * Every test asserts the FUSED forms exist with the pass on — these fail
 * on the pre-tranche code — and the kill-switch tests restore the exact
 * scalar text (no vector forms remain).
 */

const PAIR_PROGRAM = `
import System

struct Pt {
	var float x
	var float y
	var float z
}

func advance_like = (ref Pt[4] ps, float dt) {
	var int i = 0
	while i < 4; i += 1 {
		const float a_x = ps.at(i).x
		const float a_y = ps.at(i).y
		var float vx = ps.at(i).x
		var float vy = ps.at(i).y
		var int j = i + 1
		while j < 4; j += 1 {
			const float dx = a_x - ps.at(j).x
			const float dy = a_y - ps.at(j).y
			const float mag = 0.5
			vx = vx - dx * mag
			vy = vy - dy * mag
			ps.at(j).x = ps.at(j).x + dx * mag
			ps.at(j).y = ps.at(j).y + dy * mag
		}
		ps.at(i).x = vx
		ps.at(i).y = vy
	}
}

pub func main = (Init init) {
	var Pt[4] ps = [Pt(1.0, 2.0, 3.0), Pt(4.0, 5.0, 6.0), Pt(7.0, 8.0, 9.0), Pt(10.0, 11.0, 12.0),]
	advance_like(ref ps, 0.5)
	Console.write(ps.at(1).x.to_string())
	Console.write("\\n")
	Console.write(ps.at(1).y.to_string())
	Console.write("\\n")
}
`;

function compile_pair_program(on: boolean): string {
	const parsed = parse(PAIR_PROGRAM, system_lib);
	expect(parsed.errors).toEqual([]);
	set_slp_pair_enabled(on);
	try {
		return build(parsed.root, { arch: "aarch64", optimize: true }).code;
	} finally {
		set_slp_pair_enabled(true);
	}
}

test("adjacent float declares fuse to an unaligned pair load and .2d op", () => {
	const code = compile_pair_program(true);
	// The (dx, dy) distance declare pair: one 16-byte load, one .2d fsub.
	expect(code).toMatch(/ldur q\d+, \[x\d+, #\d+\]/);
	expect(code).toMatch(/fsub v\d+\.2d, v\d+\.2d, v\d+\.2d/);
});

test("the field RMW pair lowers to ldur q, .2d chain, stur q", () => {
	const code = compile_pair_program(true);
	// Load both old fields, one broadcast multiply, one .2d add, store both.
	expect(code).toMatch(/ldur q0, \[x\d+, #\d+\]/);
	expect(code).toMatch(/fmul v\d+\.2d, v\d+\.2d, v\d+\.d\[0\]/);
	expect(code).toMatch(/fadd v0\.2d, v0\.2d, v1\.2d/);
	expect(code).toMatch(/stur q0, \[x\d+, #\d+\]/);
});

test("the plain field-store pair lowers to one stur q", () => {
	const code = compile_pair_program(true);
	// `ps.at(i).x = vx` / `.y = vy` — one 16-byte store from the pair.
	expect(code).toMatch(/stur q\d+, \[x\d+, #\d+\]/);
});

test("the var-assign pair consumes the target pair in place", () => {
	const code = compile_pair_program(true);
	// vx/vy update: broadcast mul then an in-place .2d fsub on v10-style
	// pair homes (sources read before the destination lane-write).
	expect(code).toMatch(/fsub v\d+\.2d, v\d+\.2d, v1\.2d/);
});

test("kill-switch restores the scalar text (no vector forms)", () => {
	const off = compile_pair_program(false);
	const on = compile_pair_program(true);
	expect(off).not.toMatch(/\.2d/);
	expect(off).not.toMatch(/\bldur q/);
	expect(off).not.toMatch(/\bstur q/);
	expect(on).not.toEqual(off);
});

test("square-sum over a lane pair reduces with faddp", () => {
	const source = `
import System

struct Qt {
	var float x
	var float y
	var float z
}
func probe = (ref Qt[4] qs, out float) {
	var float acc = 0.0
	var int i = 0
	while i < 4; i += 1 {
		const float dx = acc - qs.at(i).x
		const float dy = acc - qs.at(i).y
		const float d2 = dx * dx + dy * dy + 1.0
		acc = acc + d2
	}
	return acc
}
pub func main = (Init init) {
	var Qt[4] qs = [Qt(1.0, 2.0, 3.0), Qt(4.0, 5.0, 6.0), Qt(7.0, 8.0, 9.0), Qt(10.0, 11.0, 12.0),]
	Console.write(probe(ref qs).to_string())
	Console.write("\\n")
}
`;
	const parsed = parse(source, system_lib);
	expect(parsed.errors).toEqual([]);
	set_slp_pair_enabled(false);
	let off: string;
	try {
		off = build(parsed.root, { arch: "aarch64", optimize: true }).code;
	} finally {
		set_slp_pair_enabled(true);
	}
	const on = build(parsed.root, { arch: "aarch64", optimize: true }).code;
	expect(on).toMatch(/faddp d\d+, v\d+\.2d/);
	expect(off).not.toMatch(/faddp/);
});

test("pair-fused binaries still produce correct output on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// P(1,2,3), P(4,5,6), P(7,8,9), P(10,11,12); dt = 0.5 — one full
	// advance-like pass, then ps.at(1) reads back (4.75, 5.75). Both
	// backends must agree (the C backend is untouched by this pass).
	await build_and_check_output(PAIR_PROGRAM, "slp_pair_behavior", "4.750000\n5.750000\n", true);
});
