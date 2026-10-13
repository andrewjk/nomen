import { describe, expect, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// B1 residual closed: the Copyable verifier extends to generic TEMPLATES.
// A bare-`T` (or `List<T>`-style) field slips the template-level verifier —
// the type param resolves to nothing there — so the mono's DERIVED
// `is_owning` used to be silent. The declaration is the contract (as for
// concrete structs): an instantiation whose substituted fields own heap
// must be able to see the mv spelling on the template.

function errors_of(input: string): string[] {
	const parsed = parse_with_imports(input);
	return parsed.errors.map((e) => e.message);
}

describe("generic template mv-spelling enforcement", () => {
	test("owning instantiation of a bare template is rejected", () => {
		const input = `
struct Wrapper<T> {
	var T value
}
var Wrapper<string> w = Wrapper<string>("x")
`;
		const errors = errors_of(input);
		expect(errors.some((e) => e.includes("'Wrapper<T>' instantiates to an owning type"))).toBe(
			true,
		);
		expect(errors.some((e) => e.includes("`mv struct Wrapper<T>`"))).toBe(true);
	});

	test("a container-typed field fires the same rule", () => {
		const input = `
struct Holder<T> {
	var List<T> items = List<T>()
}
var Holder<string> h = Holder<string>()
`;
		const errors = errors_of(input);
		expect(errors.some((e) => e.includes("instantiates to an owning type"))).toBe(true);
	});

	test("value-only instantiations stay accepted", () => {
		const input = `
struct Wrapper<T> {
	var T value
}
var Wrapper<int> w = Wrapper<int>(5)
Console.write_line("\\{w.value}")
`;
		expect(errors_of(input)).toEqual([]);
	});

	test("the spelled mv template accepts the owning instantiation", () => {
		const input = `
mv struct Wrapper<T> {
	var T value
}
var Wrapper<string> w = Wrapper<string>("x")
Console.write_line("\\{w.value}")
`;
		expect(errors_of(input)).toEqual([]);
	});

	test("each unique instantiation reports once, value ones never", () => {
		const input = `
struct Wrapper<T> {
	var T value
}
var Wrapper<string> a = Wrapper<string>("x")
var Wrapper<string> b = Wrapper<string>("y")
var Wrapper<int> c = Wrapper<int>(5)
`;
		const errors = errors_of(input);
		const owning = errors.filter((e) => e.includes("instantiates to an owning type"));
		expect(owning.length).toBe(1);
	});
});
