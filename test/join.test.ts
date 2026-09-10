import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import join, { resolve_src_module, strip_main_functions } from "../src/join.ts";

// ---------------------------------------------------------------------------
// strip_main_functions
// ---------------------------------------------------------------------------

test("strip_main_functions removes pub func main and its body, keeping the rest", () => {
	const src = `import System

pub func add = (int a, int b, out int) => a + b

pub func main = (Init init) {
	const x = add(1, 2)
	Console.write_line("\\{x}")
}
`;
	expect(strip_main_functions(src)).toBe(`import System

pub func add = (int a, int b, out int) => a + b

`);
});

test("strip_main_functions handles private func main and a body with nested braces", () => {
	const src = `func main = () {
	if true {
		Console.write("y")
	}
	for i in 0..3 {
		Console.write("\\{i}")
	}
}
func helper = () => 1
`;
	expect(strip_main_functions(src)).toBe(`func helper = () => 1
`);
});

test("strip_main_functions strips an arrow-bodied main", () => {
	expect(
		strip_main_functions(`pub func main = () => Console.write("hi")\nfunc x = () => 1\n`),
	).toBe(`func x = () => 1\n`);
});

test("strip_main_functions leaves non-main functions, calls and strings untouched", () => {
	const src = `import System
pub func add = (int a, int b, out int) => a + b
func main = () {
	const _ = add(1, 1)
}
pub func call_main = () {
	main()
}
`;
	expect(strip_main_functions(src)).toBe(`import System
pub func add = (int a, int b, out int) => a + b
pub func call_main = () {
	main()
}
`);
});

test("strip_main_functions is a no-op when there is no main", () => {
	const src = `import System
pub func add = (int a, int b, out int) => a + b
`;
	expect(strip_main_functions(src)).toBe(src);
});

test("strip_main_functions strips main's body even when it contains main as text", () => {
	const src = `import System
pub func main = () {
	Console.write("func main is just text")
}
`;
	expect(strip_main_functions(src)).toBe(`import System
`);
});

// ---------------------------------------------------------------------------
// resolve_src_module
// ---------------------------------------------------------------------------

test("resolve_src_module finds a src/ folder in the entry dir or its parent", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-src-module-"));
	try {
		fs.mkdirSync(path.join(root, "src"));
		fs.writeFileSync(path.join(root, "src", "main.nm"), "pub func main = () {}\n");
		expect(resolve_src_module(root)).toBe(path.join(root, "src"));
		expect(resolve_src_module(path.join(root, "test"))).toBe(path.join(root, "src"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("resolve_src_module returns undefined when there is no src folder", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-no-src-"));
	try {
		expect(resolve_src_module(root)).toBeUndefined();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// join: test files pull in the src/ module with main stripped
// ---------------------------------------------------------------------------

test("join for a test file inlines the src/ module with main stripped", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-join-test-"));
	try {
		fs.mkdirSync(path.join(root, "src"));
		fs.mkdirSync(path.join(root, "test"));
		fs.writeFileSync(
			path.join(root, "src", "main.nm"),
			'import System\npub func add = (int a, int b, out int) => a + b\npub func main = (Init init) {\n\tConsole.write_line("hi")\n}\n',
		);
		fs.writeFileSync(
			path.join(root, "test", "main.test.nm"),
			'import System\nimport System::Test\npub func test_add = (ref Tester t) {\n\tt.expect(add(2, 2) == 4, "2+2")\n}\n',
		);

		const input = join(path.join(root, "test", "main.test.nm"), undefined, { for_test: true });
		expect(input).toContain("pub func add = (int a, int b, out int) => a + b");
		expect(input).not.toContain("func main");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("join for a regular program does not strip main", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-join-prog-"));
	try {
		fs.mkdirSync(path.join(root, "src"));
		fs.writeFileSync(
			path.join(root, "src", "main.nm"),
			'import System\npub func add = (int a, int b, out int) => a + b\npub func main = (Init init) {\n\tConsole.write_line("hi")\n}\n',
		);
		const input = join(path.join(root, "src", "main.nm"), undefined);
		expect(input).toContain("func main");
		expect(input).toContain("pub func add");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// join: namespace (directory) imports + spaced `::` segments
// ---------------------------------------------------------------------------

function write_namespace_fixture(root: string): void {
	fs.mkdirSync(path.join(root, "src", "Types"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "src", "Types", "Diff.nm"),
		"pub struct Diff {\n\tvar x = 0\n}\n",
	);
	fs.writeFileSync(
		path.join(root, "src", "Types", "Span.nm"),
		"pub struct Span {\n\tvar y = 0\n}\n",
	);
	fs.writeFileSync(path.join(root, "src", "Types", "notes.txt"), "not a module file\n");
}

test("join resolves a namespace import to every file in the directory", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-join-ns-"));
	try {
		write_namespace_fixture(root);
		fs.writeFileSync(
			path.join(root, "src", "main.nm"),
			'import System\nimport Types\npub func main = (Init init) {\n\tConsole.write_line("hi")\n}\n',
		);
		const input = join(path.join(root, "src", "main.nm"), undefined);
		expect(input).toContain("pub struct Diff");
		expect(input).toContain("pub struct Span");
		expect(input).not.toContain("not a module file");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("join tolerates whitespace around :: segments", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-join-spaced-"));
	try {
		write_namespace_fixture(root);
		fs.writeFileSync(
			path.join(root, "src", "main.nm"),
			'import System\nimport Types:: Diff\npub func main = (Init init) {\n\tConsole.write_line("hi")\n}\n',
		);
		const input = join(path.join(root, "src", "main.nm"), undefined);
		expect(input).toContain("pub struct Diff");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("join dedupes an explicit file import covered by a namespace import", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-join-dedupe-"));
	try {
		write_namespace_fixture(root);
		fs.writeFileSync(
			path.join(root, "src", "main.nm"),
			'import System\nimport Types\nimport Types::Span\npub func main = (Init init) {\n\tConsole.write_line("hi")\n}\n',
		);
		const input = join(path.join(root, "src", "main.nm"), undefined);
		expect(input.match(/pub struct Span \{/g)?.length).toBe(1);
		expect(input).toContain("pub struct Diff");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
