import path from "node:path";

import { expect } from "vite-plus/test";

import build, { build_needs_objc, default_platform } from "../src/build";
import { get_library } from "../src/lib";
import BaseNode from "../src/nodes/BaseNode";
import { build_cache_key, load_build, save_build } from "./build_cache";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";
import { load_system_fn_names, load_system_struct_names, system_lib_fresh } from "./system_lib";

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
	extra_options: { fast_math?: boolean; audit?: boolean; platform?: string; js?: boolean } = {},
	check_options: Parameters<typeof check_output>[3] = {},
) {
	let architectures = ["aarch64", "c"] as const;
	// Struct names in the prebuilt C system.o — tells the user-TU build which
	// structs to emit itself (anything not here) vs reference from system.o.
	const system_names = load_system_struct_names();
	const system_fn_names = load_system_fn_names();
	// `js` is a harness override, not a native build option.
	const { js, ...build_extra } = extra_options;
	for (let arch of architectures) {
		const options = { arch, audit: true, ...build_extra };
		const folder = path.resolve(".", "test", "out", arch, name);
		// Warm-run cache (test/build_cache.ts): an unchanged program with an
		// unchanged compiler and library skips parse+check+codegen entirely —
		// `check_output` then replays its own cached binary/stdout.
		const key = build_cache_key({
			input,
			raw,
			kind: "native",
			arch,
			audit: options.audit,
			fast_math: options.fast_math,
			platform: options.platform,
			fresh: system_lib_fresh(arch, options.audit),
		});
		const cached = load_build(folder, key);
		if (cached) {
			expect(cached.parse_errors).toEqual([]);
			expect(cached.build_errors).toEqual([]);
			await check_output(
				name,
				{
					code: cached.code,
					headers: cached.headers,
					companion: cached.companion,
				},
				expected,
				{ ...options, system_lib: cached.split, system_fn_names, ...check_options },
			);
			continue;
		}
		// The parse MUST check with the arch being built: stage 5 moved raw
		// block target selection into `#if META.arch` pragmas, which fold at
		// check time (the stage-1 contract).
		const parsed = raw ? parse_raw(input, { arch }) : parse_with_imports(input, { arch });
		expect(parsed.errors).toEqual([]);

		// Non-GUI tests link the precompiled system.o (built once in the
		// globalSetup) instead of recompiling the System library per test —
		// the per-test System recompile was the cold-run timeout. The user TU
		// is built with emit_mode "user". GUI (ObjC) builds and programs that
		// shadow a System type keep a single TU.
		// The object is the variant built with THIS TU's audit mode: the mode
		// decides whether the generated code calls the audit runtime's wrappers
		// or libc directly, and the two halves allocate and free each other's
		// blocks — mixing them makes the audit counter meaningless (see
		// system_paths). Not FRESH (stale object from a library edit the
		// prebuild worker never rebuilt) ⇒ single TU too — pairing a stale
		// system.o with a fresh user TU is the struct-layout-crash hazard.
		// Missing variant ⇒ single TU (System compiled inline, so both halves
		// always agree).
		const split =
			!build_needs_objc(parsed.root, default_platform()) &&
			!shadows_system(parsed.root) &&
			system_lib_fresh(arch, options.audit);
		const result = split
			? build(parsed.root, { ...options, emit_mode: "user", system_struct_names: system_names })
			: build(parsed.root, options);
		// A backend build error must fail the test: a build that "succeeded"
		// with an unconstructed field once produced garbage storage that
		// passed every output assertion on the C backend (see the use_c
		// ctor-default fix and the aarch64_regressions result.errors asserts).
		expect(result.errors ?? []).toEqual([]);
		save_build(folder, key, {
			parse_errors: parsed.errors,
			build_errors: result.errors ?? [],
			split,
			code: result.code,
			headers: result.headers,
			companion: result.companion,
		});
		await check_output(name, result, expected, {
			...options,
			system_lib: split,
			system_fn_names,
			...check_options,
		});
	}

	// Optional JS-backend coverage (off by default): the same program must
	// produce the same stdout when compiled to JavaScript and run by Node.
	// The JS backend has no audit runtime, so the leak assertions don't apply.
	if (js) {
		const folder = path.resolve(".", "test", "out", "js", name);
		const key = build_cache_key({ input, raw, kind: "js", arch: "js", audit: false });
		const cached = load_build(folder, key);
		if (cached) {
			expect(cached.parse_errors).toEqual([]);
			expect(cached.build_errors).toEqual([]);
			await check_output(
				name,
				{ code: cached.code, headers: cached.headers, companion: cached.companion },
				expected,
				{ arch: "js", audit: false, provideStdin: check_options.provideStdin },
			);
		} else {
			const parsed = raw ? parse_raw(input) : parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "js" });
			expect(result.errors ?? []).toEqual([]);
			save_build(folder, key, {
				parse_errors: parsed.errors,
				build_errors: result.errors ?? [],
				split: false,
				code: result.code,
				headers: result.headers,
				companion: result.companion,
			});
			await check_output(name, result, expected, {
				arch: "js",
				audit: false,
				provideStdin: check_options.provideStdin,
			});
		}
	}
}
