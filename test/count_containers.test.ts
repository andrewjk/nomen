import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_program } from "./parse_with_imports";

// LinkedList/Tree are length-tracked by their `count` FIELD: a fresh
// constructor starts at 0, `add` appends exactly one, the link setters never
// change the count, and the evaluator resolves `x.count` through the same
// exact-length machinery as `x.length`. Their `at` contracts are phrased
// `idx < self.count`, so the facts discharge it directly; `at_or` /
// `at_or_panic` are the contract-free reads (Tree gained them 2026-11-09).

function errs(src: string) {
	return parse_program(src).errors.map((e) => e.message);
}

const REJECT = (e: string[]) =>
	e.some((m) => m.includes("cannot be verified") || m.includes("not satisfied"));

describe("count-keyed containers (LinkedList/Tree)", () => {
	test("LinkedList exact count: add tracks, at discharges", () => {
		const e = errs(`
import System
pub func main = () {
	var l = LinkedList<int>()
	l.add(5)
	var int a = l.at(0)
	l.add(6)
	var int b = l.at(1)
	Console.write("\\{a} \\{b}")
}`);
		expect(e).toEqual([]);

		const over = errs(`
import System
pub func main = () {
	var l = LinkedList<int>()
	l.add(5)
	var int a = l.at(1)
}`);
		expect(REJECT(over)).toBe(true);
	});

	test("Tree exact count: add tracks, at discharges", () => {
		const e = errs(`
import System
pub func main = () {
	var t = Tree<int>()
	t.add(5)
	t.add(6)
	var int a = t.at(1)
	Console.write("\\{a}")
}`);
		expect(e).toEqual([]);

		const over = errs(`
import System
pub func main = () {
	var t = Tree<int>()
	t.add(5)
	var int a = t.at(1)
}`);
		expect(REJECT(over)).toBe(true);
	});

	test("link setters keep the exact count fact", () => {
		const e = errs(`
import System
pub func main = () {
	var l = LinkedList<int>()
	l.add(5)
	l.set_next(0, -1)
	var int a = l.at(0)
	Console.write("\\{a}")
}`);
		expect(e).toEqual([]);
	});

	test("count guards discharge (equality and lower bound)", () => {
		const eq = errs(`
import System
pub func main = () {
	var l = LinkedList<int>()
	l.add(5)
	l.add(6)
	if l.count == 2 {
		var int a = l.at(1)
		Console.write("\\{a}")
	}
}`);
		expect(eq).toEqual([]);

		const lower = errs(`
import System
pub func main = (Tree<int> t: t.count > 0) {
	var int a = t.at(0)
	Console.write("\\{a}")
}`);
		expect(lower).toEqual([]);
	});

	test("contract-free reads (at_or / at_or_panic) need no facts", () => {
		const e = errs(`
import System
pub func main = (LinkedList<int> l: l.count == 0, Tree<int> t: t.count == 0) {
	var int a = l.at_or(0, 7)
	var int b = t.at_or(1, 9)
	var int c = l.at_or_panic(0)
	Console.write("\\{a} \\{b} \\{c}")
}`);
		expect(e).toEqual([]);
	});

	test("runtime: Tree.at_or falls back and reads in range", async () => {
		await build_and_check_output(
			`
var t = Tree<int>()
t.add(11)
var int a = t.at_or(0, 7)
var int b = t.at_or(5, 7)
Console.write("\\{a} \\{b}")
`,
			"tree_at_or",
			"11 7",
		);
	});

	test("runtime: LinkedList.at_or_panic reads in range", async () => {
		await build_and_check_output(
			`
var l = LinkedList<int>()
l.add(4)
l.add(5)
Console.write("\\{l.at_or_panic(1)}")
`,
			"ll_at_or_panic",
			"5",
		);
	});
});
