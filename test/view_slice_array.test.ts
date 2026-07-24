import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// `view T` slicing — a non-owning (ptr, len) borrow of a container's [start,
// end) range. Array<T>.slice and Buffer<T>.slice are #arch primitives in core;
// List<T>.slice and user containers delegate to their backing Buffer's slice in
// pure Nomen. Runs on both backends (C and aarch64).

describe("array/list slice (runtime, both backends)", () => {
	test("int array slice length + at", async () => {
		await build_and_check_output(
			`
			var int[] arr = [10, 20, 30, 40, 50]
			var view int v = arr.slice(1, 4)
			Console.write("\\{v.length}")
			Console.write("\\{v.at(0)}")
			Console.write("\\{v.at(2)}")`,
			"array_slice_int",
			"32040",
		);
	});

	test("char array slice", async () => {
		await build_and_check_output(
			`
			var char[] arr = ['a', 'b', 'c', 'd']
			var view char v = arr.slice(0, 3)
			Console.write(v.at(0).to_string())
			Console.write(v.at(2).to_string())`,
			"array_slice_char",
			"ac",
		);
	});

	test("List slice delegates to items.slice", async () => {
		await build_and_check_output(
			`
			var List<int> nums = List<int>()
			nums.push(1)
			nums.push(2)
			nums.push(3)
			nums.push(4)
			var view int v = nums.slice(1, 3)
			Console.write("\\{v.length}")
			Console.write("\\{v.at(0)}")
			Console.write("\\{v.at(1)}")`,
			"list_slice",
			"223",
		);
	});

	test("user container slice via Buffer delegation", async () => {
		await build_and_check_output(
			`
			// A user-defined container owns a Buffer and delegates slice to it in
			// pure Nomen (no #arch). Its slice returns a view over its elements,
			// fully borrow-checked. (alloc_int records cap so the literal-index
			// stores verify; push/grow flow-bounds are a separate concern.)
			pub struct Store: Viewable {
				var Buffer<int> items = Buffer<int>()
				pub func fill = (ref self) {
					self.items.alloc_int(4)
					self.items.store_int(0, 5)
					self.items.store_int(1, 6)
					self.items.store_int(2, 7)
					self.items.store_int(3, 8)
				}
				pub func slice = (self, int start: start >= 0, int end: end >= start, out view int) {
					return self.items.slice(start, end)
				}
			}
			var Store p = Store()
			p.fill()
			var view int v = p.slice(1, 3)
			Console.write("\\{v.length}")
			Console.write("\\{v.at(0)}")
			Console.write("\\{v.at(1)}")`,
			"user_slice",
			"267",
		);
	});
});

// Check-only tests for borrow semantics on non-string views.
function errors(src: string) {
	return parse(src, lib).errors.map((e) => `${e.message}`);
}

describe("view T borrow semantics", () => {
	test("int-array slice + length + at typecheck", () => {
		expect(
			errors(`
			import System
			pub func main = () {
				var int[] arr = [1, 2, 3]
				var view int v = arr.slice(0, 2)
				Console.write("\\{v.length}")
				Console.write("\\{v.at(0)}")
			}`),
		).toEqual([]);
	});

	test("returning an array view is rejected", () => {
		expect(
			errors(`
			import System
			func bad = (int[] a: a.length >= 2, out view int) {
				return a.slice(0, 2)
			}
			pub func main = () { Console.write("x") }`).some((m) => m.includes("borrowed reference")),
		).toBe(true);
	});

	test("using an array view after reassigning its source is rejected", () => {
		expect(
			errors(`
			import System
			pub func main = () {
				var int[] arr = [1, 2, 3]
				if arr.length == 3 {
					var view int v = arr.slice(0, 2)
					arr = [9, 9, 9]
					Console.write("\\{v.length}")
				}
			}`).some((m) => m.includes("invalidat")),
		).toBe(true);
	});
});
