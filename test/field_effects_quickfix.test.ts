import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

/**
 * The structured quick-fix payloads the checker attaches to declared-effect
 * diagnostics (FIELD_EFFECTS.md). The VSCode extension applies them verbatim:
 * insert a new field set, extend an existing one, or
 * extend an existing set. Every shape must re-parse cleanly with the
 * diagnostic gone.
 */

const PROGRAM = (param: string, body: string) => `import System

mv struct Inner {
	var n = 0
}

mv struct Item {
	var Box<Inner> inner
	var Box<Inner> spare
}

func touch = (${param}) {
	${body}
}

pub func main = (Init init) {
	var item = Item(mv Box<Inner>(mv Inner()), mv Box<Inner>(mv Inner()))
	touch(ref item)
}
`;

function apply_quick_fix(
	param: string,
	body: string,
): { signature?: string; errors: string[]; warning_gone: boolean } {
	const source = PROGRAM(param, body);
	const first = parse(source, system, "/tmp/probe.nomen", { allow_internal: true });
	// Same family selector as the inline tests below: this file's fixes edit
	// parameter field sets (the lint warnings), and the checker's own
	// declared-set errors carry the same kind of fix.
	const diag = [...first.errors, ...first.warnings].find(
		(d) =>
			!!d.quick_fix &&
			(d.message.startsWith("Ref parameter") ||
				d.message.startsWith("Method receiver") ||
				d.message.includes("but the body writes")),
	);
	expect(diag, "expected a diagnostic carrying a quick fix").toBeDefined();
	const fix = diag!.quick_fix!;
	const edited =
		fix.insert_offset !== undefined
			? source.slice(0, fix.insert_offset) + fix.insert_text + source.slice(fix.insert_offset)
			: source.slice(0, fix.replace_start!) + fix.replace_text! + source.slice(fix.replace_end!);
	const second = parse(edited, system, "/tmp/probe.nomen", { allow_internal: true });
	return {
		signature: edited.split("\n").find((l) => l.includes("func touch")),
		errors: second.errors.map((e) => e.message),
		warning_gone: !second.warnings.some((w) => w.quick_fix),
	};
}

describe("declared-effect quick fixes", () => {
	test("un-annotated parameter: insert a new clause", () => {
		const result = apply_quick_fix("ref Item item", "item.inner = mv Box<Inner>(mv Inner())");
		expect(result.signature).toBe("func touch = (ref Item item { inner }) {");
		expect(result.errors).toEqual([]);
		expect(result.warning_gone).toBe(true);
	});

	test("ref self: the quick fix edits the receiver's set", () => {
		const source = `import System

mv struct Inner {
	var n = 0
}

mv struct Item {
	var Box<Inner> inner

	func touch = (ref self {}) {
		self.inner = mv Box<Inner>(mv Inner())
	}
}

pub func main = (Init init) {
	var item = Item(mv Box<Inner>(mv Inner()))
	item.touch()
}
`;
		const first = parse(source, system, "/tmp/probe.nomen", { allow_internal: true });
		// The declared-effect diagnostics this file tests: their quick fixes
		// edit parameter field sets. Quick-fix-carrying lints with earlier
		// source positions exist (the redundant-type-annotation lint), so the
		// selector names the family instead of taking the first fix.
		const diag = [...first.errors, ...first.warnings].find(
			(d) =>
				!!d.quick_fix &&
				(d.message.startsWith("Ref parameter") ||
					d.message.startsWith("Method receiver") ||
					d.message.includes("but the body writes")),
		);
		expect(diag).toBeDefined();
		const fix = diag!.quick_fix!;
		const edited =
			fix.insert_offset !== undefined
				? source.slice(0, fix.insert_offset) + fix.insert_text + source.slice(fix.insert_offset)
				: source.slice(0, fix.replace_start!) + fix.replace_text! + source.slice(fix.replace_end!);
		expect(edited.split("\n").find((l) => l.includes("func touch"))).toBe(
			"	func touch = (ref self { inner }) {",
		);
		expect(parse(edited, system, "/tmp/probe.nomen", { allow_internal: true }).errors).toEqual([]);
	});

	test("existing set: extend it inside the braces", () => {
		const result = apply_quick_fix(
			"ref Item item { spare }",
			"item.inner = mv Box<Inner>(mv Inner())",
		);
		expect(result.signature).toBe("func touch = (ref Item item { spare, inner }) {");
		expect(result.errors).toEqual([]);
	});

	test("empty braces: insert the fields inside them", () => {
		const result = apply_quick_fix("ref Item item {}", "item.inner = mv Box<Inner>(mv Inner())");
		expect(result.signature).toBe("func touch = (ref Item item { inner }) {");
		expect(result.errors).toEqual([]);
	});

	test("multi-field sets render comma-separated", () => {
		const source = PROGRAM(
			"ref Item item",
			`	item.inner = mv Box<Inner>(mv Inner())
	item.spare = mv Box<Inner>(mv Inner())`,
		).replace("pub func main = (Init init) {", "pub func main = (Init init) {");
		const first = parse(source, system, "/tmp/probe.nomen", { allow_internal: true });
		// The declared-effect diagnostics this file tests: their quick fixes
		// edit parameter field sets. Quick-fix-carrying lints with earlier
		// source positions exist (the redundant-type-annotation lint), so the
		// selector names the family instead of taking the first fix.
		const diag = [...first.errors, ...first.warnings].find(
			(d) =>
				!!d.quick_fix &&
				(d.message.startsWith("Ref parameter") ||
					d.message.startsWith("Method receiver") ||
					d.message.includes("but the body writes")),
		);
		// Two undeclared writes accumulate into one set with sorted fields.
		expect(diag?.quick_fix?.insert_text).toBe(" { inner, spare }");
	});

	test("un-annotated scalar mutator: declare `{}`", () => {
		const source = `import System

mv struct Item {
	var int n
}

func touch = (ref Item item) {
	item.n = item.n + 1
}

pub func main = (Init init) {
	var Item item = Item(0)
	touch(ref item)
}
`;
		const first = parse(source, system, "/tmp/probe.nomen", { allow_internal: true });
		// The declared-effect diagnostics this file tests: their quick fixes
		// edit parameter field sets. Quick-fix-carrying lints with earlier
		// source positions exist (the redundant-type-annotation lint), so the
		// selector names the family instead of taking the first fix.
		const diag = [...first.errors, ...first.warnings].find(
			(d) =>
				!!d.quick_fix &&
				(d.message.startsWith("Ref parameter") ||
					d.message.startsWith("Method receiver") ||
					d.message.includes("but the body writes")),
		);
		expect(diag).toBeDefined();
		const fix = diag!.quick_fix!;
		expect(fix.insert_text).toBe(" {}");
		const edited =
			source.slice(0, fix.insert_offset!) + fix.insert_text + source.slice(fix.insert_offset!);
		expect(edited.split("\n").find((l) => l.includes("func touch"))).toBe(
			"func touch = (ref Item item {}) {",
		);
		const second = parse(edited, system, "/tmp/probe.nomen", { allow_internal: true });
		expect(second.errors).toEqual([]);
		expect(second.warnings.filter((w) => w.message.startsWith("Ref parameter"))).toEqual([]);
	});

	test("un-annotated ref self reader: quick fix uses bare self", () => {
		const source = `import System

mv struct Item {
	var int n

	func peek = (ref self, out int) {
		return self.n
	}
}

pub func main = (Init init) {
	var Item item = Item(1)
	Console.write("\\{item.peek()}")
}
`;
		const first = parse(source, system, "/tmp/probe.nomen", { allow_internal: true });
		// The declared-effect diagnostics this file tests: their quick fixes
		// edit parameter field sets. Quick-fix-carrying lints with earlier
		// source positions exist (the redundant-type-annotation lint), so the
		// selector names the family instead of taking the first fix.
		const diag = [...first.errors, ...first.warnings].find(
			(d) =>
				!!d.quick_fix &&
				(d.message.startsWith("Ref parameter") ||
					d.message.startsWith("Method receiver") ||
					d.message.includes("but the body writes")),
		);
		expect(diag).toBeDefined();
		const fix = diag!.quick_fix!;
		const edited =
			source.slice(0, fix.replace_start!) + fix.replace_text! + source.slice(fix.replace_end!);
		expect(edited.split("\n").find((l) => l.includes("func peek"))).toBe(
			"	func peek = (self, out int) {",
		);
		const second = parse(edited, system, "/tmp/probe.nomen", { allow_internal: true });
		expect(second.errors).toEqual([]);
		expect(
			second.warnings.filter(
				(w) => w.message.startsWith("Method receiver") || w.message.startsWith("Ref parameter"),
			),
		).toEqual([]);
	});
});
