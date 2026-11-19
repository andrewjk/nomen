import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";

// Regression (FOLLOWUP, "raw_type_size doesn't ride the shared layout
// model"): the check-side T_SIZE mirror for raw/unsafe T-generic bodies
// walked only a struct's OWN fields, so an element carrying a
// trait-declared field (the trait tail the C typedef and the aarch64
// `get_struct_size` both emit) substituted a short stride — every slab slot
// past the first misreads. raw_type_size now delegates to the shared
// layout model (src/build_common/layout.ts), the same walk the aarch64
// backend lays out with. TaggedItem: vt(8) + id(8) + trait tag(16) = 32;
// the old mirror answered 16.

const trait_lib = get_library(path.resolve(import.meta.dirname, "fixtures/tsize_trait_lib"));

function compiled_aarch64_fn(element: string): string {
	const input = `import System
pub func main = () {
	var TSizeTraitBox<${element}> b = TSizeTraitBox<${element}>()
	b.alloc_direct(4)
}
`;
	const parsed = parse(input, trait_lib);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	const label = `TSizeTraitBox_${element}_alloc_direct:`;
	const end = `.return_${label.slice(0, -1)}:`;
	return result.code.slice(result.code.indexOf(label), result.code.indexOf(end));
}

test("a trait-field element's stride includes the trait tail", () => {
	const fn = compiled_aarch64_fn("TaggedItem");
	expect(fn).toContain("mov x1, #32");
	expect(fn).not.toContain("mov x1, #16");
	expect(fn).toContain("bl foreign_calloc");
	expect(fn).not.toContain("T_SIZE");
});

test("a string element keeps the fat-pair stride", () => {
	const fn = compiled_aarch64_fn("string");
	expect(fn).toContain("mov x1, #16");
	expect(fn).not.toContain("T_SIZE");
});

// The fixture file must not drift from what these pins rely on.
test("fixture declares the shapes the pins compile", () => {
	const source = fs.readFileSync(
		path.resolve(import.meta.dirname, "fixtures/tsize_trait_lib/TSizeTraitBox.nm"),
		"utf8",
	);
	expect(source).toContain("calloc(count, T_SIZE)");
	expect(source).toContain("trait Tagged");
});
