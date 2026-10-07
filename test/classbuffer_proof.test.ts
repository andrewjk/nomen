import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Proof that the ClassBuffer<T> compile-time mechanism works: the element
// destroy is monomorphized directly into #destroy (T_destroy -> Animal_destroy),
// store_int forbids 0, and elements are freed on destroy. This de-risks the
// full ClassBuffer/ValueBuffer split before migrating the containers.

describe("ClassBuffer<T> compile-time class freeing", () => {
	test("monomorphized #destroy calls the element destroy directly (no leak)", async () => {
		// ClassBuffer<T> stores 8-byte POINTER elements — the surviving shape
		// is a class-stamped T, i.e. `Box<Animal>` (an owning struct element
		// is inline and retires with the class tier). The monomorphized
		// ClassBuffer_Box_Cell.#destroy must call Box_Cell_destroy directly
		// — the T_destroy substitution — and elements are freed on destroy.
		const input = `
owning struct Animal {
	var char letter
	func #destroy = (ref self) {
		self.letter = ' '
	}
}
if true {
	var ClassBuffer<Box<Animal>> buf = ClassBuffer<Box<Animal>>()
	buf.alloc_int(4)
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "classbuffer_proof", "done\n");
		const asm = fs.readFileSync(
			path.join("test", "out", "aarch64", "classbuffer_proof", "main.s"),
			"utf-8",
		);
		expect(asm).toContain("bl Box_Animal_destroy");
	});

	test("store_int rejects 0 (val != 0 prevents the leak footgun)", () => {
		const input = `
owning struct Animal {
	var char letter
	func #destroy = (ref self) {
		self.letter = ' '
	}
}
var ClassBuffer<Box<Animal>> buf = ClassBuffer<Box<Animal>>()
buf.alloc_int(4)
buf.store_int(0, 0)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});
