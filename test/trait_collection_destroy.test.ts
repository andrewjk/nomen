import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Milestone 1: trait-typed heterogeneous storage works end-to-end. The
// compiler now (a) routes a trait-T element type to ClassBuffer<Trait>
// (parallel to the existing class-T routing in monomorphize), and
// (b) dispatches trait-typed destroy through a per-struct vtable slot so
// the per-element reclaim in ClassBuffer<T>.#destroy reaches the actual
// conforming struct's destroy. Together these unblock the storage /
// destroy half of `Array<Control>`-style heterogeneous trait collections.
// (Elements must be classes — value structs can no longer be implicitly
// boxed into trait-typed slots; declare them as classes instead.)

describe("ClassBuffer<Trait> polymorphic destroy (Milestone 1)", () => {
	test("Buffer<Speaker> field type routes to ClassBuffer_Speaker", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }
class Dog : Speaker { func speak = (self, out string) { return "woof" } }

if true {
	var List<Speaker> list = List<Speaker>()
	Console.write("ok")
}
`;
		// A List<Speaker> field declares `Buffer<Speaker> items`. With the
		// monomorphize fix that recognises trait-T as class-like, the field
		// rewrites to ClassBuffer_Speaker (not Buffer_Speaker).
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch, audit: false });
			const file = arch === "c" ? "main.m" : "main.s";
			const codePath = path.join("test", "out", arch, "cb_trait_routing", file);
			fs.mkdirSync(path.dirname(codePath), { recursive: true });
			fs.writeFileSync(codePath, result.code);
			expect(result.code).toContain("ClassBuffer_Speaker");
			expect(result.code).not.toMatch(/\bBuffer_Speaker\b/);
		}
	});

	test("List<Speaker> destroys class elements via vtable dispatch", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }
class Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
	func #destroy = (ref self) {
		Console.write("destroying " + self.name)
	}
}

if true {
	var List<Speaker> pets = List<Speaker>()
	pets.push(mov Dog("Rex"))
}
Console.write("\\ndone")
`;
		// When pets goes out of scope, ClassBuffer_Speaker's #destroy loops
		// each slot, calling Speaker_destroy(slot[i]) (substituted from
		// T_destroy). Speaker_destroy dispatches via the destroy slot in the
		// struct's vtable to Dog_destroy, which prints "destroying Rex". Then
		// ClassBuffer frees the slot itself.
		await build_and_check_output(input, "cb_trait_destroy_class", "destroying Rex\ndone");

		// Verify the aarch64 path emits Speaker_destroy as a real symbol.
		const asm = fs.readFileSync(
			path.join("test", "out", "aarch64", "cb_trait_destroy_class", "main.s"),
			"utf-8",
		);
		expect(asm).toMatch(/Speaker_destroy:/);
	});

	test("List<Speaker> without a user #destroy still reclaims class fields", async () => {
		// Dog has no user #destroy, but the class auto-destroy walks its
		// fields (string name) and frees them. With audit on, this would
		// leak without proper destroy dispatch through the vtable.
		const input = `
trait Speaker { func speak = (self, out string) }
class Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
}

if true {
	var List<Speaker> pets = List<Speaker>()
	pets.push(mov Dog("Rex"))
}
Console.write("done")
`;
		await build_and_check_output(input, "cb_trait_auto_destroy", "done");
	});

	test("List<Speaker> with multiple conforming classes dispatches each", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }
class Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
	func #destroy = (ref self) {
		Console.write("dog " + self.name)
	}
}
class Cat : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
	func #destroy = (ref self) {
		Console.write("cat " + self.name)
	}
}

if true {
	var List<Speaker> pets = List<Speaker>()
	pets.push(mov Dog("Rex"))
	pets.push(mov Cat("Tom"))
}
Console.write(" done")
`;
		// Both Dog_destroy and Cat_destroy dispatch through the Speaker vtable
		// destroy slot. Order matches insertion order (the buffer is walked
		// front-to-back on destroy).
		await build_and_check_output(input, "cb_trait_multi", "dog Rexcat Tom done");
	});
});
