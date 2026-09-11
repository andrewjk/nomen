import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { analyze, ref_at } from "../extension/src/analysis.ts";
import { build_source_map, map_offset } from "../extension/src/source_map.ts";
import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function make_project(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-ext-"));
	for (const [name, text] of Object.entries(files)) {
		const full = path.join(dir, name);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, text);
	}
	return dir;
}

describe("extension project imports", () => {
	test("subfolder imports are pulled into the source map", () => {
		const dir = make_project({
			"main.nm": `import System
import types::CharChange

pub func main = () {
	var CharChange c = CharChange()
}
`,
			"types/CharChange.nm": `pub struct CharChange {
	var int index
}
`,
		});
		const file = path.join(dir, "main.nm");
		const text = fs.readFileSync(file, "utf8");
		const map = build_source_map(file, text, system);
		expect(map.segments.map((s) => s.path)).toContain(path.join(dir, "types/CharChange.nm"));
	});

	test("old slash import spelling works too", () => {
		const dir = make_project({
			"main.nm": `import System
import types/CharChange

pub func main = () {
	var CharChange c = CharChange()
}
`,
			"types/CharChange.nm": `pub struct CharChange {
	var int index
}
`,
		});
		const file = path.join(dir, "main.nm");
		const text = fs.readFileSync(file, "utf8");
		const map = build_source_map(file, text, system);
		expect(map.segments.map((s) => s.path)).toContain(path.join(dir, "types/CharChange.nm"));
	});

	test("hover and go-to-definition resolve into the imported file", () => {
		const dir = make_project({
			"main.nm": `import System
import types::CharChange

pub func render = (List<CharChange> changes, out string) {
	return ""
}
`,
			"types/CharChange.nm": `pub struct CharChange {
	var int index
}
`,
		});
		const file = path.join(dir, "main.nm");
		const text = fs.readFileSync(file, "utf8");
		const map = build_source_map(file, text, system);
		const parsed = parse(map.source.slice(0, map.user_end), system, file);
		expect(parsed.errors).toEqual([]);
		const analysis = analyze(parsed.root, map.source);

		// The `CharChange` use inside `List<CharChange>` resolves …
		const use = text.indexOf("CharChange>");
		const ref = ref_at(analysis, use);
		expect(ref?.def.name).toBe("CharChange");

		// … to the declaration in the imported file.
		const loc = map_offset(map, ref!.def.start, ref!.def.length)!;
		expect(loc.path).toBe(path.join(dir, "types/CharChange.nm"));
		const target = fs.readFileSync(loc.path, "utf8");
		expect(target.slice(loc.character, loc.character + 10)).toBe("CharChange");
	});

	test("deleting the import reports an unknown type", () => {
		const dir = make_project({
			"main.nm": `import System

pub func main = () {
	var CharChange c = CharChange()
}
`,
			"types/CharChange.nm": `pub struct CharChange {
	var int index
}
`,
		});
		const file = path.join(dir, "main.nm");
		const text = fs.readFileSync(file, "utf8");
		const map = build_source_map(file, text, system);
		expect(map.segments.map((s) => s.path)).not.toContain(path.join(dir, "types/CharChange.nm"));
		const parsed = parse(map.source.slice(0, map.user_end), system, file);
		expect(parsed.errors.map((e) => e.message)).toContain("Unknown type: CharChange");
	});

	test("transitive imports and cycles terminate without duplicates", () => {
		// Note: like the compiler's module joiner, nested-file imports
		// resolve against the entry folder (not the importing file's own
		// folder), so `a/A.nm` reaches `a/b/B.nm` via `import a::b::B`.
		const dir = make_project({
			"main.nm": `import System
import a::A

pub func main = () {
	var A a = A()
}
`,
			"a/A.nm": `import a::b::B
import ../main

pub struct A {
	var int x
}
`,
			"a/b/B.nm": `import a::A

pub struct B {
	var int y
}
`,
		});
		const file = path.join(dir, "main.nm");
		const text = fs.readFileSync(file, "utf8");
		const map = build_source_map(file, text, system);
		const paths = map.segments.map((s) => s.path);
		expect(paths).toContain(path.join(dir, "a/A.nm"));
		expect(paths).toContain(path.join(dir, "a/b/B.nm"));
		expect(paths.length).toBe(new Set(paths).size);
	});

	test("test files pull the src module and its transitive imports", () => {
		// Mirrors the compiler's test join: test/*.test.nm sees src/*.nm,
		// and the src files' own imports (e.g. `import utils` reaching
		// `src/utils/*.nm`) are followed too — resolved against the src
		// module root, like the joiner's folder_path.
		const dir = make_project({
			"test/app.test.nm": `import System
import System::Test

pub func uses_transform = (ref Tester t) {
	t.expect(transform("x") == "x", "round trip")
}
`,
			"src/main.nm": `import System
import transform

pub func main = (Init init) {
	Console.write(transform("hi"))
}
`,
			"src/transform.nm": `import utils

pub func transform = (string s, out string) {
	return shout(s)
}
`,
			"src/utils/shout.nm": `pub func shout = (string s, out string) {
	return s
}
`,
		});
		const file = path.join(dir, "test", "app.test.nm");
		const text = fs.readFileSync(file, "utf8");
		const map = build_source_map(file, text, system);
		const paths = map.segments.map((s) => s.path);
		expect(paths).toContain(path.join(dir, "src", "transform.nm"));
		expect(paths).toContain(path.join(dir, "src", "utils", "shout.nm"));
		// The program's own main is stripped (the harness supplies main),
		// but its other declarations stay visible.
		const main_seg = map.segments.find((s) => s.path === path.join(dir, "src", "main.nm"))!;
		const main_text = map.source.slice(main_seg.start, main_seg.end);
		expect(main_text).not.toContain("func main");
		const parsed = parse(map.source.slice(0, map.user_end), system, file);
		expect(parsed.errors).toEqual([]);
	});

	test("missing import targets are ignored", () => {
		const dir = make_project({
			"main.nm": `import System
import nope::Missing

pub func main = () {
}
`,
		});
		const file = path.join(dir, "main.nm");
		const text = fs.readFileSync(file, "utf8");
		const map = build_source_map(file, text, system);
		expect(map.segments.map((s) => s.path)).not.toContain(path.join(dir, "nope/Missing.nm"));
	});
});
