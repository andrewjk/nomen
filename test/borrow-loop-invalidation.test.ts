import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// Probe tests: borrow invalidation across loops (the control-flow pin behind
// docs/GROUP_BORROWING.md, "Control flow"). Valen needs a pre-pass that scouts
// a loop body's invalidations and replays them before the body, because a
// reference there can outlive an iteration. Nomen claims the replay is
// unnecessary: borrows are scope-bound, loop-body locals are cleaned up each
// iteration (MEMORY.md, "Loops"), and invalidations performed inside the body
// persist into the enclosing scope via `persist_invalidated`
// (check_for_loop_node / check_while_loop_node). These probes pin that claim
// as tests instead of an inference.
//
// The borrow shape is a `view string` slice (roots at its source variable);
// the invalidating call is `String.set`, a `ref self` method.

function errors(src: string) {
	return parse(src, lib).errors.map((e) => `${e.message}`);
}

describe("borrow declared before the loop", () => {
	test("a ref self call inside a for body invalidates a use after the loop", () => {
		// The body may have run before the post-loop code, so the invalidation
		// must persist out of the loop (persist_invalidated). A checker that
		// dropped it with the body's cloned status would accept this program.
		const errs = errors(`
import System
pub func main = () {
	var string s = "hello"
	var view string v = s.slice(0, 3)
	for i of 0..2 {
		s.set(0, 'H')
	}
	Console.write("\\{v.length}")
}`);
		expect(errs.some((m) => m.includes("invalidated"))).toBe(true);
	});

	test("a ref self call inside a while body invalidates a use after the loop", () => {
		const errs = errors(`
import System
pub func main = () {
	var string s = "hello"
	var view string v = s.slice(0, 3)
	var int i = 0
	while i < 2 {
		s.set(0, 'H')
		i += 1
	}
	Console.write("\\{v.length}")
}`);
		expect(errs.some((m) => m.includes("invalidated"))).toBe(true);
	});

	test("an invalidation inside an if inside the body persists past the loop", () => {
		// Branch union composes with loop repetition: the if-branch clone
		// invalidates, check_if_else_node unions it into the body status, and
		// persist_invalidated carries it across the loop boundary.
		const errs = errors(`
import System
pub func main = () {
	var string s = "hello"
	var view string v = s.slice(0, 3)
	for i of 0..2 {
		if i == 1 {
			s.set(0, 'H')
		}
	}
	Console.write("\\{v.length}")
}`);
		expect(errs.some((m) => m.includes("invalidated"))).toBe(true);
	});
});

describe("borrow declared inside the body", () => {
	test("invalidated later in the same body is rejected", () => {
		// Each iteration re-declares the borrow from the current source, but
		// within one iteration the statement order still rules: a use after
		// the invalidating call must fail.
		const errs = errors(`
import System
pub func main = () {
	var string s = "hello"
	for i of 0..2 {
		var view string v = s.slice(0, 3)
		s.set(0, 'H')
		Console.write("\\{v.length}")
	}
}`);
		expect(errs.some((m) => m.includes("invalidated"))).toBe(true);
	});

	test("used before the invalidating call in the same iteration is accepted", () => {
		// The linear per-iteration model: the use precedes the mutation, so
		// every iteration's read is valid. No replay pass needed.
		expect(
			errors(`
import System
pub func main = () {
	var string s = "hello"
	for i of 0..2 {
		var view string v = s.slice(0, 3)
		Console.write("\\{v.length}")
		s.set(0, 'H')
	}
}`),
		).toEqual([]);
	});

	test("re-fetched after the invalidating call in the same iteration is accepted", () => {
		// The documented recovery ("re-fetch it after the mutation") works
		// per-iteration: the fresh slice borrows from the post-mutation owner.
		expect(
			errors(`
import System
pub func main = () {
	var string s = "hello"
	for i of 0..2 {
		s.set(0, 'H')
		var view string v = s.slice(0, 3)
		Console.write("\\{v.length}")
	}
}`),
		).toEqual([]);
	});
});
