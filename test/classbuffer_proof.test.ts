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
		const input = `
class Animal { var char letter }
if true {
	var ClassBuffer<Animal> buf = ClassBuffer<Animal>()
	buf.alloc_int(4)
}
Console.write("done\\n")
`;
		// The monomorphized ClassBuffer_Animal.#destroy must call Animal_destroy
		// directly — i.e. the T_destroy -> Animal_destroy substitution happened.
		await build_and_check_output(input, "classbuffer_proof", "done\n");
		const asm = fs.readFileSync(
			path.join("test", "out", "aarch64", "classbuffer_proof", "main.s"),
			"utf-8",
		);
		expect(asm).toContain("bl Animal_destroy");
	});

	test("store_int rejects 0 (val != 0 prevents the leak footgun)", () => {
		const input = `
class Animal { var char letter }
var ClassBuffer<Animal> buf = ClassBuffer<Animal>()
buf.alloc_int(4)
buf.store_int(0, 0)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});
