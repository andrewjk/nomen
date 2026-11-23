import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { current_lib_source_hash } from "./system_lib";

/**
 * Persistent per-test BUILD cache. `check_output` already caches the compiled
 * binary and its stdout, but a warm run still re-parses the program together
 * with the appended System library, re-checks it, and re-runs codegen for
 * every test — ~200-400ms per backend. This module memoizes the whole
 * parse+check+build pipeline keyed by (program, flags, compiler sources,
 * library sources), so an unchanged test on a warm run is a file read.
 *
 * Invalidation:
 * - any compiler edit (`src/**\/*.ts` content hash) regenerates the key;
 * - any library edit (`core/**`, via `current_lib_source_hash`) regenerates it;
 * - the program text and every build/parse flag are part of the key;
 * - `fresh` records whether the precompiled system object the split decision
 *   depends on is usable, so a missing/stale `system.o` cannot replay a
 *   split-TU build.
 */

let compiler_hash: string | null = null;

/** Content hash of every compiler source file under `src/`. */
export function compiler_source_hash(): string {
	if (compiler_hash !== null) return compiler_hash;
	const root = path.resolve("src");
	const h = crypto.createHash("sha256");
	const walk = (dir: string): void => {
		const entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".ts")) {
				h.update(path.relative(root, full));
				h.update(fs.readFileSync(full));
			}
		}
	};
	walk(root);
	compiler_hash = h.digest("hex").slice(0, 16);
	return compiler_hash;
}

export interface CachedBuild {
	/** The parse/check errors (always empty — only successful builds cache). */
	parse_errors: unknown[];
	/** Build-phase errors (always empty — only successful builds cache). */
	build_errors: unknown[];
	/** Whether the build used the precompiled system object (emit_mode "user"). */
	split: boolean;
	code: string;
	headers: string;
	companion?: string;
}

const CACHE_FILE = ".build.json";

/** Per-key cache filename (folders can be shared by many programs). */
function cache_file_for(folder: string, key: string): string {
	return path.join(folder, `${key}${CACHE_FILE}`);
}

/** Compute the cache key for one (program, flags) combination. */
export function build_cache_key(parts: {
	input: string;
	raw: boolean;
	kind: "native" | "js";
	arch: string;
	audit?: boolean;
	fast_math?: boolean;
	platform?: string;
	fresh?: boolean;
	/** Extra dims that affect the result (toggle state, raw-statement mode). */
	extra?: string;
}): string {
	const h = crypto.createHash("sha256");
	h.update(
		JSON.stringify({
			input: parts.input,
			raw: parts.raw,
			kind: parts.kind,
			arch: parts.arch,
			audit: parts.audit ?? true,
			fast_math: !!parts.fast_math,
			platform: parts.platform ?? process.platform,
			fresh: !!parts.fresh,
			extra: parts.extra ?? "",
		}),
	);
	h.update(compiler_source_hash());
	h.update(current_lib_source_hash());
	return h.digest("hex").slice(0, 24);
}

/** Load a cached build for `folder`, or undefined on a miss. */
export function load_build(folder: string, key: string): CachedBuild | undefined {
	try {
		const raw = fs.readFileSync(cache_file_for(folder, key), "utf8");
		const data = JSON.parse(raw) as { key: string; build: CachedBuild };
		if (data.key !== key) return undefined;
		return data.build;
	} catch {
		return undefined;
	}
}

/** Persist a successful build for `folder` (atomic temp-then-rename). */
export function save_build(folder: string, key: string, build: CachedBuild): void {
	fs.mkdirSync(folder, { recursive: true });
	const target = cache_file_for(folder, key);
	const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
	fs.writeFileSync(tmp, JSON.stringify({ key, build }));
	fs.renameSync(tmp, target);
}

/**
 * Parse+check+build one program with the persistent build cache. Returns the
 * same shape the local test helpers (`run(...)` etc.) need: the parsed errors
 * and a Built-like result carrying the generated text. AST-inspecting tests
 * must not use this (the AST is not serialized).
 */
export function cached_compile(
	input: string,
	opts: {
		arch: "c" | "aarch64" | "js";
		audit?: boolean;
		fast_math?: boolean;
		platform?: string;
		raw?: boolean;
		allow_internal?: boolean;
		/** Extra key dimension (toggle state etc.). */
		extra?: string;
		folder: string;
		parse?: (source: string, options: { arch?: string }) => unknown;
		build?: (
			root: unknown,
			options: Record<string, unknown>,
		) => {
			code: string;
			headers?: string;
			companion?: string;
			errors?: unknown[];
		};
	},
):
	| {
			parse_errors: unknown[];
			build_errors: unknown[];
			code: string;
			headers: string;
			companion?: string;
	  }
	| undefined {
	const { folder, parse, build, ...flags } = opts;
	if (!parse || !build) return undefined;
	const key = build_cache_key({
		input,
		raw: !!flags.raw,
		kind: flags.arch === "js" ? "js" : "native",
		arch: flags.arch,
		audit: flags.audit ?? true,
		fast_math: flags.fast_math,
		platform: flags.platform,
		extra: flags.extra,
	});
	const cached = load_build(folder, key);
	if (cached) return cached;
	const parsed = parse(input, {
		arch: flags.arch,
		...(flags.allow_internal ? { allow_internal: true } : {}),
	}) as {
		root: unknown;
		errors: unknown[];
	};
	if (parsed.errors.length) {
		// A failing parse is deterministic; don't cache it (the assertion that
		// follows reports it), and let the caller's expect() do the reporting.
		return { parse_errors: parsed.errors, build_errors: [], code: "", headers: "" };
	}
	const result = build(parsed.root, {
		arch: flags.arch,
		audit: flags.audit ?? true,
		...(flags.fast_math ? { fast_math: true } : {}),
		...(flags.platform ? { platform: flags.platform } : {}),
	});
	const entry = {
		parse_errors: parsed.errors,
		build_errors: result.errors ?? [],
		code: result.code,
		headers: result.headers ?? "",
		companion: result.companion,
	};
	if (!entry.build_errors.length) {
		save_build(folder, key, { ...entry, split: false });
	}
	return entry;
}

/**
 * A boolean "this harness asserted successfully" marker. Used by the
 * byte-identity harnesses (emit_nir / emit_c_nir) whose work is two
 * compilations plus a text comparison: on a warm run with an unchanged
 * compiler and library the comparison is deterministic, so the marker stands
 * in for re-running both arms.
 */
export function load_marker(folder: string, key: string): boolean {
	try {
		return fs.readFileSync(path.join(folder, `${key}.ok`), "utf8") === "1";
	} catch {
		return false;
	}
}

export function save_marker(folder: string, key: string): void {
	fs.mkdirSync(folder, { recursive: true });
	const target = path.join(folder, `${key}.ok`);
	if (!fs.existsSync(target)) {
		fs.writeFileSync(target, "1");
	}
}
