import { expect, test } from "vite-plus/test";

import {
	eliminate_dead_copy_moves,
	set_dead_move_elimination_enabled,
} from "../src/build_aarch64/asm_opt";

/**
 * Dead copy-move elimination (ASM_PLAN_4 SLP follow-on): `mov xD, xS`
 * whose destination is never read below — before redefinition, on every
 * path — is dropped. The soundness model is the two-set backward scan
 * (live + control-flow taint); these tests pin the cases its development
 * got wrong: switch-arm joins, def-and-read chains, call arguments,
 * return values, and fat returns through branches.
 *
 * The pass ships default-OFF (measured-loss convention: −1.3…−1.5% on
 * nbody 5M — the removed `.at()` markers executed in the OoO shadow);
 * every prune expectation opts in for the call and restores afterwards.
 */
function with_pass(run: () => void): void {
	set_dead_move_elimination_enabled(true);
	try {
		run();
	} finally {
		set_dead_move_elimination_enabled(false);
	}
}

test("straight-line dead staging marker is pruned", () => {
	with_pass(() => {
		const code = "mov x0, x26\nldr d0, [x26, #8]\nfmov d9, d0";
		expect(eliminate_dead_copy_moves(code)).toBe("ldr d0, [x26, #8]\nfmov d9, d0");
	});
});

test("a read below keeps the move", () => {
	with_pass(() => {
		const code = "mov x0, x26\nadd x0, x0, x1\nbl _memcpy";
		expect(eliminate_dead_copy_moves(code)).toBe(code);
	});
});

test("def-and-read instruction keeps its own feeding move", () => {
	with_pass(() => {
		const code = "mov x9, x19\nadd x9, x9, #16";
		expect(eliminate_dead_copy_moves(code)).toBe(code);
	});
});

test("switch arms are never pruned (join liveness)", () => {
	with_pass(() => {
		// x13 is defined on every arm and read at the join — a linear-scan
		// universe reset let one arm's definition kill the other arm's
		// need and corrupted switch lowering; the taint model keeps all.
		const code = [
			"mov x13, x0",
			"mov x2, x12",
			"cmp x1, x2",
			"b.hs sw_next",
			"mov x13, #1",
			"b end_switch",
			"sw_next:",
			"mov x2, x12",
			"mov x13, x28",
			"end_switch:",
			"mov x0, x13",
			"str x0, [x19]",
		].join("\n");
		expect(eliminate_dead_copy_moves(code)).toBe(code);
	});
});

test("call arguments keep their staging moves", () => {
	with_pass(() => {
		const code = "mov x3, x19\nmov x2, x1\nbl _snprintf";
		expect(eliminate_dead_copy_moves(code)).toBe(code);
	});
});

test("return-value moves survive the ret boundary", () => {
	with_pass(() => {
		const code = "mov x0, x19\nret";
		expect(eliminate_dead_copy_moves(code)).toBe(code);
		// …and nothing crosses the function boundary: a dead move AFTER
		// the ret (the next function's body) is pruned even though the
		// same shape before the ret is kept — the ret's x0 doesn't reach
		// it.
		const two = "mov x0, x19\nret\nmov x0, x19\nstrb w2, [x19, x1]";
		expect(eliminate_dead_copy_moves(two)).toBe("mov x0, x19\nret\nstrb w2, [x19, x1]");
	});
});

test("fat returns through branches are kept (b flows to ret)", () => {
	with_pass(() => {
		// `mov x1, x0` feeds the ret via the branch target — pruning it
		// returned garbage length halves (the first crash receipt).
		const code = "bl _snprintf\nmov x1, x0\nb .Lend\n.Lend:\nldp x29, x30, [sp], #16\nret";
		expect(eliminate_dead_copy_moves(code)).toBe(code);
	});
});

test("kill-switch restores the text byte-identically", () => {
	const code = "mov x0, x26\nldr d0, [x26, #8]\nfmov d9, d0";
	set_dead_move_elimination_enabled(false);
	try {
		expect(eliminate_dead_copy_moves(code)).toBe(code);
	} finally {
		set_dead_move_elimination_enabled(true);
	}
	expect(eliminate_dead_copy_moves(code)).toBe("ldr d0, [x26, #8]\nfmov d9, d0");
	set_dead_move_elimination_enabled(false);
});

test("w-register siblings share fate (w write defines x view)", () => {
	with_pass(() => {
		const code = "mov w1, w9\nstrb w1, [x0]";
		expect(eliminate_dead_copy_moves(code)).toBe(code);
	});
});
