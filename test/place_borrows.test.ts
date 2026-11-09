import { describe, expect, test } from "vite-plus/test";

import { parse_program } from "./parse_with_imports";

// Place-scoped element borrows: the slot-borrow rewrite stamps the place an
// element borrow points into (`ref Ship s = ships.at(0)` → `[0]`,
// `f.ships.at(2)` → `ships[2]`), and List's modeled single-slot mutators
// (`set` / `set_or_panic` — the exact-length model's sibling) invalidate
// only the places they actually displace. A slot write provably disjoint
// from the borrow's place — literal vs literal, or two names under a
// recorded `i != j` guard — leaves the borrow live. Everything else
// (push/pop/reassign: realloc, shift, slab free) keeps the declared-set
// wholesale behavior, as does any unprovable stamp.

const PROGRAM = `
import System

mv struct Ship {
	var int fuel
}

pub func main = (int i, int j) {
	var ships = List<Ship>()
	ships.push(mv Ship(10))
	ships.push(mv Ship(20))
BODY
}
`;

function check(body: string) {
	return parse_program(PROGRAM.replace("BODY", body));
}

function invalidated(parsed: { errors: { message: string }[] }): boolean {
	return parsed.errors.some((e) => e.message.includes("invalidated"));
}

describe("place-scoped element borrows (List slot writes)", () => {
	test("a sibling-slot set survives the borrow", () => {
		const parsed = check(`
		ref Ship first = ships.at(0)
		ships.set(1, mv Ship(99))
		Console.write("\\{first.fuel}")`);
		expect(parsed.errors).toEqual([]);
	});

	test("a same-slot set is still rejected", () => {
		const parsed = check(`
		ref Ship first = ships.at(0)
		ships.set(0, mv Ship(99))
		Console.write("\\{first.fuel}")`);
		expect(invalidated(parsed)).toBe(true);
	});

	test("push still invalidates (realloc — declared-set path)", () => {
		const parsed = check(`
		ref Ship first = ships.at(0)
		ships.push(mv Ship(3))
		Console.write("\\{first.fuel}")`);
		expect(invalidated(parsed)).toBe(true);
	});

	test("pop still invalidates (tail displacement — declared-set path)", () => {
		const parsed = check(`
		ref Ship first = ships.at(0)
		ships.pop()
		Console.write("\\{first.fuel}")`);
		expect(invalidated(parsed)).toBe(true);
	});

	test("field-path receivers stamp and match places", () => {
		// The field-path `at` bounds contract does not discharge yet (the
		// documented guards-only residual — no exact length tracking on field
		// paths), so the contract error is expected in every variant; what
		// this test asserts is the INVALIDATION channel: set_or_panic on a
		// disjoint slot spares the borrow, a same-slot write and a push do
		// not.
		const mk = (body: string) =>
			parse_program(`
import System

mv struct Ship {
	var int fuel
}

mv struct Fleet {
	var List<Ship> ships = List<Ship>()
}

pub func main = () {
	var f = Fleet()
	f.ships.push(mv Ship(1))
	f.ships.push(mv Ship(2))
	ref Ship first = f.ships.at(0)
	${body}
}`);
		const survive = mk(`f.ships.set_or_panic(1, mv Ship(9))
		Console.write("\\{first.fuel}")`);
		expect(survive.errors.some((e) => e.message.includes("invalidated"))).toBe(false);

		expect(
			invalidated(
				mk(`f.ships.set_or_panic(0, mv Ship(9))
		Console.write("\\{first.fuel}")`),
			),
		).toBe(true);

		expect(
			invalidated(
				mk(`f.ships.push(mv Ship(3))
		Console.write("\\{first.fuel}")`),
			),
		).toBe(true);
	});

	test("an `i != j` guard lets set(j) spare an at(i) borrow", () => {
		const parsed = check(`
		if i >= 0 && i < ships.length && j >= 0 && j < ships.length {
			ref Ship first = ships.at(i)
			if i != j {
				ships.set(j, mv Ship(7))
				Console.write("\\{first.fuel}")
			}
		}`);
		expect(parsed.errors).toEqual([]);
	});

	test("without the guard the name-vs-name set poisons the borrow", () => {
		const parsed = check(`
		if i >= 0 && i < ships.length && j >= 0 && j < ships.length {
			ref Ship first = ships.at(i)
			ships.set(j, mv Ship(7))
			Console.write("\\{first.fuel}")
		}`);
		expect(invalidated(parsed)).toBe(true);
	});

	test("a same-name set is the same slot", () => {
		const parsed = check(`
		var int idx = 1
		if idx >= 0 && idx < ships.length {
			ref Ship first = ships.at(idx)
			ships.set(idx, mv Ship(7))
			Console.write("\\{first.fuel}")
		}`);
		expect(invalidated(parsed)).toBe(true);
	});

	test("reassigning the index variable downgrades the stamp", () => {
		// `first` was taken at slot `idx` (0 at the time); once `idx` is
		// reassigned the stamp no longer describes the slot, so the later
		// set(idx) poisons conservatively.
		const parsed = check(`
		var int idx = 0
		if idx >= 0 && idx < ships.length {
			ref Ship first = ships.at(idx)
			idx = 1
			if idx >= 0 && idx < ships.length {
				ships.set(idx, mv Ship(5))
				Console.write("\\{first.fuel}")
			}
		}`);
		expect(invalidated(parsed)).toBe(true);
	});

	test("set_or_panic gets the same place precision", () => {
		const parsed = check(`
		ref Ship first = ships.at(0)
		ships.set_or_panic(1, mv Ship(99))
		Console.write("\\{first.fuel}")`);
		expect(parsed.errors).toEqual([]);
	});
});
