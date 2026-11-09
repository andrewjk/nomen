import { expect, test } from "vite-plus/test";

import { parse_program } from "./parse_with_imports";

const SHIP = `
import System

mv struct Ship {
	var int fuel
}
`;

function errs(src: string) {
	return parse_program(src).errors.map((e) => e.message);
}

const REJECT = (e: string[]) =>
	e.some((m) => m.includes("cannot be verified") || m.includes("not satisfied"));

test("param contract carries a length fact", () => {
	// The callee relies on the signature contract; no guard in the body.
	const e = errs(`${SHIP}
func first_of = (List<Ship> ships: ships.length > 0, out int) {
	var Ship s = ships.at(0)
	return s.fuel
}
pub func main = () {
	var ships = List<Ship>()
	ships.push(mv Ship(10))
	Console.write("\\{first_of(ships)}")
}`);
	expect(e).toEqual([]);
});

test("param contract must be proven at the call site", () => {
	const e = errs(`${SHIP}
func first_of = (List<Ship> ships: ships.length > 0, out int) {
	var Ship s = ships.at(0)
	return s.fuel
}
pub func main = () {
	var ships = List<Ship>()
	Console.write("\\{first_of(ships)}")
}`);
	expect(REJECT(e)).toBe(true);
});

test("return contract carries a length fact", () => {
	const e = errs(`${SHIP}
func make = (out List<Ship>: out.length > 0) {
	var ships = List<Ship>()
	ships.push(mv Ship(10))
	return ships
}
pub func main = () {
	var List<Ship> ships = make()
	var Ship s = ships.at(0)
	Console.write("\\{s.fuel}")
}`);
	expect(e).toEqual([]);
});
