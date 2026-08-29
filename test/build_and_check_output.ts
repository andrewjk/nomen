import fs from "node:fs";
import path from "node:path";

import { expect } from "vite-plus/test";

import build, { build_needs_objc, default_platform } from "../src/build";
import { get_library } from "../src/lib";
import BaseNode from "../src/nodes/BaseNode";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";
import {
	SYSTEM_OBJ,
	SYSTEM_OBJ_A64,
	load_system_fn_names,
	load_system_struct_names,
} from "./system_lib";

const system_lib = get_library(path.resolve("core"));

/** True when the program defines a type whose name is also a System library
 *  type (e.g. `struct File` shadows System's `File` — including one declared
 *  inside `main`, which parse_with_imports wraps). In that case the precompiled
 *  system.o would collide (both objects define `File_*`), so such programs
 *  must build as a single TU. */
function shadows_system(root: { statements: BaseNode[] }): boolean {
	const visit = (node: BaseNode | undefined | null): boolean => {
		if (!node || typeof node !== "object") return false;
		if (
			(node.node_type === "struct" ||
				node.node_type === "trait" ||
				node.node_type === "enum" ||
				node.node_type === "bitset") &&
			!(node as { is_library?: boolean }).is_library &&
			system_lib.types.has((node as unknown as { name: string }).name)
		) {
			return true;
		}
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const v = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(v)) {
				for (const item of v) if (visit(item as BaseNode)) return true;
			} else if (v && typeof v === "object" && "node_type" in v) {
				if (visit(v as BaseNode)) return true;
			}
		}
		return false;
	};
	for (const stmt of root.statements) {
		if (visit(stmt)) return true;
	}
	return false;
}

export default async function build_and_check_output(
	input: string,
	name: string,
	expected: string,
	raw = false,
	extra_options: { fast_math?: boolean } = {},
) {
	let architectures = ["aarch64", "c"] as const;
	// Struct names in the prebuilt C system.o — tells the user-TU build which
	// structs to emit itself (anything not here) vs reference from system.o.
	const system_names = load_system_struct_names();
	const system_fn_names = load_system_fn_names();
	// aarch64 uses the prebuilt-object split (link the precompiled system.o).
	const a64_split = fs.existsSync(SYSTEM_OBJ_A64);
	const c_split = fs.existsSync(SYSTEM_OBJ);
	for (let arch of architectures) {
		const parsed = raw ? parse_raw(input) : parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch, audit: true, ...extra_options };
		// Non-GUI tests link the precompiled system.o (built once in the
		// globalSetup) instead of recompiling the System library per test —
		// the per-test System recompile was the cold-run timeout. The user TU
		// is built with emit_mode "user". GUI (ObjC) builds and programs that
		// shadow a System type keep a single TU.
		const split =
			!build_needs_objc(parsed.root, default_platform()) &&
			!shadows_system(parsed.root) &&
			(arch === "aarch64" ? a64_split : c_split);
		const result = split
			? build(parsed.root, { ...options, emit_mode: "user", system_struct_names: system_names })
			: build(parsed.root, options);
		await check_output(name, result, expected, {
			...options,
			system_lib: split,
			system_fn_names,
		});
	}
}
