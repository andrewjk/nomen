import path from "node:path";

import { expect } from "vite-plus/test";

import build from "../src/build";
import { cached_compile } from "./build_cache";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

/**
 * Correlated warm-run helpers for test files that build a program and compare
 * its stdout directly (the local `run(...)` wrappers). Routes the whole
 * parse+check+codegen pipeline through the persistent build cache
 * (test/build_cache.ts), so an unchanged program on a warm run costs a file
 * read; `check_output` still replays or re-runs the binary through its own
 * cache. AST-inspecting tests must keep calling `parse_with_imports` directly
 * (the AST is not serialized).
 */
export function compile_cached(
	input: string,
	opts: {
		name: string;
		arch: "c" | "aarch64" | "js";
		audit?: boolean;
		fast_math?: boolean;
		platform?: string;
		raw?: boolean;
		/** Parse with allow_internal (bench/harness programs). */
		allow_internal?: boolean;
		/** Extra key dimension (toggle state etc.). */
		extra?: string;
	},
) {
	const folder = path.resolve(".", "test", "out", opts.arch, opts.name);
	return cached_compile(input, {
		arch: opts.arch,
		audit: opts.audit,
		fast_math: opts.fast_math,
		platform: opts.platform,
		raw: opts.raw,
		allow_internal: opts.allow_internal,
		extra: opts.extra,
		folder,
		parse: (source, o) => (opts.raw ? parse_raw(source) : parse_with_imports(source, o as never)),
		build,
	});
}

/** Build `input` (cached) and assert its stdout on the requested backend(s). */
export async function run_cached(
	name: string,
	input: string,
	expected: string,
	opts: {
		arch: "c" | "aarch64" | "js";
		audit?: boolean;
		fast_math?: boolean;
		platform?: string;
		raw?: boolean;
		allow_internal?: boolean;
	} & Parameters<typeof check_output>[3],
): Promise<void> {
	const built = compile_cached(input, { ...opts, name });
	if (!built) throw new Error(`compile_cached returned nothing for '${name}'`);
	expect(built.parse_errors).toEqual([]);
	expect(built.build_errors).toEqual([]);
	await check_output(
		name,
		{ code: built.code, headers: built.headers, companion: built.companion },
		expected,
		opts,
	);
}
