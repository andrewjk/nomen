import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

const core = get_library(import.meta.dirname.replace(/\/?test$/, "/core"));

function module_of(body: string, imports = "System"): string {
	return `${imports}\npub func main = () {\n${body}\n}\n`;
}

describe("namespace imports", () => {
	test("import System::Controls compiles", () => {
		const input = `import System::Controls
`;
		expect(parse(input, core).errors).toEqual([]);
	});

	test("a module file is not an import path", () => {
		// docs/SCOPING.md: files are invisible to imports — only namespace
		// directories are importable.
		const input = `import System::Controls::Geometry
`;
		expect(parse(input, core).errors).toEqual([
			{
				message: "Unknown import path: System::Controls::Geometry",
				start: 0,
				line: 1,
				column: 1,
			},
		]);
	});

	test("bare module import compiles", () => {
		const input = `import Map
`;
		expect(parse(input, core).errors).toEqual([]);
	});
});

describe("import path errors", () => {
	test("typo'd namespace import is an error", () => {
		const input = `
import System::Contrls
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "Unknown import path: System::Contrls", 2, 1),
		]);
	});

	test("typo'd last segment is an error", () => {
		const input = `
import System::Controls::Contrls
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "Unknown import path: System::Controls::Contrls", 2, 1),
		]);
	});

	test("path with no matching module is an error", () => {
		const input = `
import System::Collections::List
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "Unknown import path: System::Collections::List", 2, 1),
		]);
	});

	test("non-System imports are left alone", () => {
		// Bare and project-relative imports (`import Map`,
		// `import types::CharChange`) name project files resolved by the
		// module joiner, not the library index, so they are not validated.
		const input = `
import Foo
import types::CharChange
`;
		expect(parse(input, core).errors).toEqual([]);
	});
});

describe("qualified references", () => {
	test("qualified constructor builds the same code as the bare name", () => {
		const imports = "import System\nimport System::Controls";
		const qualified = parse(
			module_of(
				`var Size s = Controls::Size()
	\tConsole.write("\\{s.width} \\{s.height}")`,
				imports,
			),
			core,
		);
		const bare = parse(
			module_of(
				`var Size s = Size()
	\tConsole.write("\\{s.width} \\{s.height}")`,
				imports,
			),
			core,
		);
		expect(qualified.errors).toEqual([]);
		expect(bare.errors).toEqual([]);
		expect(trim_test_build(build(qualified.root).code)).toEqual(
			trim_test_build(build(bare.root).code),
		);
	});

	test("qualified type-level method call compiles", () => {
		const input = module_of(
			`const ok = Text::Regex.test("a+b", "aaab")
	\tConsole.write("\\{ok}")`,
			"import System\nimport System::Text",
		);
		expect(parse(input, core).errors).toEqual([]);
	});

	test("qualified reference without a namespace import is gated", () => {
		// docs/SCOPING.md: `import System` grants only System's own names —
		// `Text::Regex` needs `import System::Text` (or System::Text::Regex),
		// however the reference is spelled. Both the annotation and the
		// constructor report.
		const input = module_of(`var Text::Regex r = Text::Regex()`);
		const errors = parse(input, core).errors;
		expect(errors.length).toBe(2);
		expect(errors[0].message).toBe("Namespace System::Text is not imported");
		expect(errors[1].message).toBe("Namespace System::Text is not imported");
	});
});

describe("qualified reference errors", () => {
	test("unknown namespace prefix", () => {
		const input = module_of(`var Size s = Control::Geometry::Size()`);
		expect(parse(input, core).errors).toEqual([
			test_error(input, "Namespace Control::Geometry is not imported", 3, 14),
		]);
	});

	test("typo'd root namespace", () => {
		const input = module_of(`var Size s = Systm::Controls::Geometry::Size()`);
		expect(parse(input, core).errors).toEqual([
			test_error(input, "Namespace Systm::Controls::Geometry is not imported", 3, 14),
		]);
	});

	test("unknown qualified name still reports the bare name", () => {
		// The prefix names the namespace (`Controls`); the final segment is the
		// entity name, resolved flat — an unknown one reports as the bare name.
		const input = module_of(
			`var Size s = Controls::Siz()`,
			"import System\nimport System::Controls",
		);
		const errors = parse(input, core).errors;
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("Function not found: Siz");
	});
});
