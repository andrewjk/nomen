import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

const core = get_library(import.meta.dirname.replace(/\/?test$/, "/core"));

function module_of(body: string): string {
	return `import System\npub func main = () {\n${body}\n}\n`;
}

describe("namespace imports", () => {
	test("import System::Controls compiles", () => {
		const input = `import System::Controls
`;
		expect(parse(input, core).errors).toEqual([]);
	});

	test("deep import System::Controls::Geometry compiles", () => {
		const input = `import System::Controls::Geometry
`;
		expect(parse(input, core).errors).toEqual([]);
	});
});

describe("qualified references", () => {
	test("qualified constructor builds the same code as the bare name", () => {
		const qualified = parse(
			module_of(`var Controls::Geometry::Size s = System::Controls::Geometry::Size()
\tConsole.write("\\{s.width} \\{s.height}")`),
			core,
		);
		const bare = parse(
			module_of(`var Size s = Size()
\tConsole.write("\\{s.width} \\{s.height}")`),
			core,
		);
		expect(qualified.errors).toEqual([]);
		expect(bare.errors).toEqual([]);
		expect(trim_test_build(build(qualified.root).code)).toEqual(
			trim_test_build(build(bare.root).code),
		);
	});

	test("qualified type-level method call compiles", () => {
		const input = module_of(`const ok = Text::Regex.test("a+b", "aaab")
\tConsole.write("\\{ok}")`);
		expect(parse(input, core).errors).toEqual([]);
	});

	test("qualified reference without a namespace import resolves by bare name", () => {
		const input = module_of(`var Text::Regex r = Text::Regex()`);
		expect(parse(input, core).errors).toEqual([]);
	});
});

describe("qualified reference errors", () => {
	test("unknown namespace prefix", () => {
		const input = module_of(`var Size s = Control::Geometry::Size()`);
		expect(parse(input, core).errors).toEqual([
			test_error(input, "Unknown namespace: Control", 3, 14),
		]);
	});

	test("typo'd root namespace", () => {
		const input = module_of(`var Size s = Systm::Controls::Geometry::Size()`);
		expect(parse(input, core).errors).toEqual([
			test_error(input, "Unknown namespace: Systm", 3, 14),
		]);
	});

	test("unknown qualified name still reports the bare name", () => {
		const input = module_of(`var Size s = Controls::Geometry::Siz()`);
		const errors = parse(input, core).errors;
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("Function not found: Siz");
	});
});
