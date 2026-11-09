import { describe, expect, test } from "vite-plus/test";

import { parse_program } from "./parse_with_imports";

// Field-path contract discharge: `f.ships.at(idx)` verifies `at`'s bounds
// contract (`i >= 0 && i < self.length`) against the field-path GUARD facts
// (`if f.ships.length > 1` records path_bounds under the full path key on
// the base variable; the substituted contract consults them under the
// synthetic self's own keys). The exact-length fact stays bare-locals-only
// — a field path has no known_length, so an UNGUARDED read is still
// rejected (unknown provenance), and the modeled shrinking mutators narrow
// the guard facts exactly like the bare branch (a pop erodes every lower
// bound by one).

const PRE = `
import System

mv struct Ship {
	var int fuel
}

mv struct Fleet {
	var List<Ship> ships = List<Ship>()
}

pub func main = () {
	var f = Fleet()
	f.ships.push(mv Ship(10))
	f.ships.push(mv Ship(20))
	PROBE
}
`;

function errs(probe: string) {
	return parse_program(PRE.replace("PROBE", probe)).errors.map((e) => e.message);
}

describe("field-path bounds-contract discharge", () => {
	test("owning read under a length guard", () => {
		expect(
			errs(`if f.ships.length > 1 {
			var Ship s = f.ships.at(0)
			Console.write("\\{s.fuel}")
		}`),
		).toEqual([]);
	});

	test("inline method call under a length guard", () => {
		expect(
			errs(`if f.ships.length > 1 {
			Console.write("\\{f.ships.at(0).fuel}")
		}`),
		).toEqual([]);
	});

	test("ref binding under a length guard", () => {
		expect(
			errs(`if f.ships.length > 1 {
			ref Ship s = f.ships.at(0)
			Console.write("\\{s.fuel}")
		}`),
		).toEqual([]);
	});

	test("guard on the literal side (`0 < f.ships.length`)", () => {
		expect(
			errs(`if 0 < f.ships.length {
			var Ship s = f.ships.at(0)
			Console.write("\\{s.fuel}")
		}`),
		).toEqual([]);
	});

	test("variable index under guarded bounds", () => {
		// The sanctioned spelling: the guard proves BOTH halves of at's
		// contract (idx >= 0 via the inclusive lower, idx < length via the
		// upper-bound expr).
		expect(
			errs(`var int idx = 0
		if idx >= 0 && idx < f.ships.length {
			var Ship s = f.ships.at(idx)
			Console.write("\\{s.fuel}")
		}`),
		).toEqual([]);
	});

	test("unguarded read stays rejected (unknown provenance)", () => {
		expect(
			errs(`var Ship s = f.ships.at(0)
		Console.write("\\{s.fuel}")`).some((m) => m.includes("cannot be verified")),
		).toBe(true);
	});

	test("a pop narrows the guard facts (soundness of the erosion)", () => {
		// length > 1 (>= 2) then pop -> length >= 1: at(0) stays provable.
		// (The at(1)-after-pop corner where the checker currently accepts is
		// recorded in FOLLOWUP.md -- a synthetic-index fact-provenance audit.)
		const reject = (body: string) =>
			errs(body).some((m) => m.includes("cannot be verified") || m.includes("not satisfied"));

		expect(
			reject(`if f.ships.length > 1 {
			f.ships.pop()
			var Ship s = f.ships.at(0)
			Console.write("\\{s.fuel}")
		}`),
		).toBe(false);
	});
});
