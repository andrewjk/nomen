import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { analyze } from "../extension/src/analysis";
import { build_source_map } from "../extension/src/source_map";
import parse from "../src/parse";

// `build_source_map` is what the editor extension feeds into `parse`: the
// document's text plus its sibling modules (and, for user code, the parent
// folder), so editor features see declarations defined in neighbouring files.
// These tests write a small project tree to a temp dir and verify that
// cross-file references resolve.

let root: string;

function setup(): string {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-srcmap-"));
	return root;
}

function write(rel: string, text: string): string {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, text);
	return full;
}

function analyze_file(file_path: string) {
	const text = fs.readFileSync(file_path, "utf8");
	const map = build_source_map(file_path, text, undefined);
	const parsed = parse(map.source.slice(0, map.user_end), undefined, file_path);
	return {
		map,
		errors: parsed.errors,
		analysis: analyze(parsed.root, map.source),
	};
}

describe("source_map sibling resolution", () => {
	test("a user file sees pub items declared in a sibling file", () => {
		setup();
		write("mod/a.nm", "pub struct Point {\n    pub var int x = 0\n}\n");
		write("mod/b.nm", "var Point p = Point()\np.x = 1\n");
		const { errors, analysis } = analyze_file(path.join(root, "mod", "b.nm"));
		expect(errors).toEqual([]);
		expect(analysis.defs.some((d) => d.name === "Point" && d.kind === "struct")).toBe(true);
	});

	test("a user file sees private file-level items declared in a sibling file", () => {
		setup();
		// The compiler concatenates a folder at build time, so private
		// file-level declarations are visible across siblings — the editor
		// source map reproduces that.
		write("mod/a.nm", "func helper = (out int) {\n    return 42\n}\n");
		write("mod/b.nm", "var int x = helper()\n");
		const { errors, analysis } = analyze_file(path.join(root, "mod", "b.nm"));
		expect(errors).toEqual([]);
		expect(analysis.defs.some((d) => d.name === "helper" && d.kind === "func")).toBe(true);
	});

	test("a user file in a subfolder sees pub items in its parent folder", () => {
		setup();
		write("src/parent.nm", "pub func parent_helper = (out int) {\n    return 42\n}\n");
		write("src/utils/child.nm", "var int x = parent_helper()\n");
		const { errors, analysis } = analyze_file(path.join(root, "src", "utils", "child.nm"));
		expect(errors).toEqual([]);
		expect(analysis.defs.some((d) => d.name === "parent_helper")).toBe(true);
	});

	test("the document's own segment stays at offset 0 of the combined source", () => {
		setup();
		write("mod/a.nm", "pub struct Point {\n    pub var int x = 0\n}\n");
		write("mod/b.nm", "var Point p = Point()\n");
		const text = "var Point p = Point()\n";
		const file_b = path.join(root, "mod", "b.nm");
		const map = build_source_map(file_b, text, undefined);
		expect(map.segments[0]).toEqual({ start: 0, end: text.length, path: file_b });
		expect(map.doc_end).toEqual(text.length);
		expect(map.user_end).toBeGreaterThan(text.length);
	});

	test("files in the parent folder's subfolders (siblings of the parent) are not inlined", () => {
		// Only `.nm` files directly in the parent folder are pulled in, not
		// other subfolders of the parent (the parent's own siblings stay out).
		setup();
		write("src/parent.nm", "pub func parent_helper = (out int) {\n    return 42\n}\n");
		write("src/other/uncle.nm", "pub func uncle_helper = (out int) {\n    return 1\n}\n");
		write("src/utils/child.nm", "var int x = parent_helper()\n");
		const file_path = path.join(root, "src", "utils", "child.nm");
		const text = fs.readFileSync(file_path, "utf8");
		const map = build_source_map(file_path, text, undefined);
		const paths = map.segments.map((s) => s.path);
		expect(paths.some((p) => p.endsWith("parent.nm"))).toBe(true);
		expect(paths.some((p) => p.endsWith("uncle.nm"))).toBe(false);
	});
});
