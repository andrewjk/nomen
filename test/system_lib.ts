import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import build from "../src/build";
import built_in_types from "../src/built_in_types";
import { build_library, get_library } from "../src/lib";
import RootNode from "../src/nodes/RootNode";
import parse from "../src/parse";
import { postprocess_macos } from "./postprocess";

const execPromise = util.promisify(exec);

/**
 * The precompiled System translation units, one per backend. Built ONCE (in a
 * vitest globalSetup, before any test) and linked into every non-GUI test, so
 * no test ever recompiles the System library — the per-test recompile of
 * inlined System source was what blew past the 5s timeout whenever a codegen
 * change invalidated the per-test output cache.
 *
 * Rebuilt only when its inputs change: the System library source
 * (`core/System/**`) or the generated system TU (a compiler codegen change
 * that affects System output). Either way it's a single `clang -c`, paid once
 * outside every per-test timeout.
 */
export const SYSTEM_LIB_DIR = path.resolve("test/out/system_lib");

/**
 * One system object per AUDIT MODE. A build's two halves must agree: the
 * audit mode decides whether the generated code calls the audit runtime's
 * wrappers or libc's malloc/free directly, and the object is linked into user
 * TUs built either way. Mixing them means the same allocation is allocated by
 * one allocator and freed by the other — the audit counter counts blocks the
 * program never reclaims (and vice versa), so the LEAK number drifts away
 * from the allocator's real state, and the runtime cannot tell a correct free
 * from an invalid one. So `system.o` is the audited variant and
 * `system_plain.o` the plain one; tests pick by their own audit flag.
 */
export function system_paths(arch: "c" | "aarch64", audit: boolean) {
	const dir = path.join(SYSTEM_LIB_DIR, arch === "c" ? "c" : "aarch64");
	const suffix = audit ? "" : "_plain";
	return {
		obj: path.join(dir, `system${suffix}.o`),
		hash: path.join(dir, `.hash${suffix}`),
		// The System library SOURCE hash the object was built from (the
		// freshness gate's marker — see system_lib_fresh).
		libhash: path.join(dir, `.libhash${suffix}`),
		src:
			arch === "c"
				? path.join(dir, `system${suffix}${process.platform === "darwin" ? ".m" : ".c"}`)
				: path.join(dir, `system${suffix}.s`),
		h: path.join(dir, `system${suffix}.h`),
		// aarch64-only (the C system TU has no companion); unused for "c".
		companion: path.join(dir, `system${suffix}_companion.o`),
	};
}

// C backend (audited — the default variant)
export const SYSTEM_OBJ = path.join(SYSTEM_LIB_DIR, "c", "system.o");
export const SYSTEM_H = path.join(SYSTEM_LIB_DIR, "c", "system.h");
export const SYSTEM_HASH = path.join(SYSTEM_LIB_DIR, "c", ".hash");
/** Struct names defined in system.o (C). Test builds emit any struct NOT in
 *  this set into the user TU, so a generic/tuple the canonical didn't
 *  instantiate (e.g. `Buffer<float>`, `_Tuple_int_string_bool`) is generated
 *  per-test instead of left undefined. */
export const SYSTEM_NAMES = path.join(SYSTEM_LIB_DIR, "c", "names.json");
// aarch64 backend
export const SYSTEM_OBJ_A64 = path.join(SYSTEM_LIB_DIR, "aarch64", "system.o");
/** The aarch64 system object's companion (C bodies of `aarch64_use_c` library
 *  functions, e.g. Stream/Tcp's socket helpers). Linked next to system.o —
 *  the runtime is NOT here, so the user companion stays the single copy. */
export const SYSTEM_COMPANION_A64 = path.join(SYSTEM_LIB_DIR, "aarch64", "system_companion.o");
export const SYSTEM_HASH_A64 = path.join(SYSTEM_LIB_DIR, "aarch64", ".hash");
/** Function names exported by the aarch64 system object. The user TU's
 *  references to these are rewritten to the `_name` alias (Mach-O convention). */
export const SYSTEM_NAMES_A64 = path.join(SYSTEM_LIB_DIR, "aarch64", "names.json");

/** Load the struct names in the prebuilt C system.o (empty if not built). */
export function load_system_struct_names(): Set<string> {
	try {
		return new Set(JSON.parse(fs.readFileSync(SYSTEM_NAMES, "utf8")) as string[]);
	} catch {
		return new Set();
	}
}

/** Load the function names exported by the prebuilt aarch64 system.o. */
export function load_system_fn_names(): string[] {
	try {
		return JSON.parse(fs.readFileSync(SYSTEM_NAMES_A64, "utf8")) as string[];
	} catch {
		return [];
	}
}

/**
 * The System library SOURCE's hash, computed the same way
 * `ensure_system_lib` records it. Uses `build_library` (a fresh read of every
 * core file) rather than `get_library` — the latter's per-process cache would
 * freeze a snapshot taken before a library edit, defeating the freshness
 * gate. Memoized per process: within one suite run the library state is
 * fixed, and re-reading all of core/ per test would dominate warm runs.
 */
let memoized_lib_source_hash: string | null = null;
export function current_lib_source_hash(): string {
	if (memoized_lib_source_hash === null) {
		const lib = build_library(path.resolve("core"));
		memoized_lib_source_hash = crypto
			.createHash("sha256")
			.update(lib.source)
			.digest("hex")
			.slice(0, 16);
	}
	return memoized_lib_source_hash;
}

/**
 * Whether the prebuilt system object may be LINKED into a fresh user TU: the
 * object exists AND the recorded library-source hash matches the CURRENT
 * System library source. The split-build contract is that system.o and the
 * user TU were produced from the same library state — pairing a STALE object
 * (a library edit the prebuild worker never rebuilt: failed worker, watch
 * session) with a fresh user TU is the struct-layout-crash hazard. A
 * not-fresh object is treated exactly like a missing one: single-TU fallback
 * (slower, but both halves always agree).
 */
export function system_lib_fresh(arch: "c" | "aarch64", audit: boolean): boolean {
	const paths = system_paths(arch, audit);
	if (!fs.existsSync(paths.obj)) return false;
	if (!fs.existsSync(paths.hash)) return false;
	if (!fs.existsSync(paths.libhash)) return false;
	try {
		return fs.readFileSync(paths.libhash, "utf8") === current_lib_source_hash();
	} catch {
		return false;
	}
}

/**
 * Build the canonical program that pulls the ENTIRE non-GUI System library
 * into one system TU.
 *
 * Two mechanisms (both feed `resolve_linked_types`, which pulls any library
 * type whose name appears as a token, plus its deps):
 *  1. Name every non-GUI System type (`var int <Type> = 0`) — pulls all
 *     non-generic System code (Console, int_to_string, File, …).
 *  2. Instantiate every System generic with the common primitive element
 *     types — pulls those monomorphizations (`List<int>`, `Map<string,int>`,
 *     …) into the system TU so any test using them links the prebuilt object.
 *
 * GUI types (core/System/Controls, ObjC/Cocoa) are excluded — GUI builds keep
 * a single TU.
 */
function canonical_program(): string {
	const lib = get_library(path.resolve("core"));

	// Primitive type names can't be declared as identifiers (they'd collide
	// with the type keyword); they're pulled in via parse.ts BASE_TYPES.
	const primitives = new Set<string>(built_in_types);
	const types = (Array.from(lib.types.entries()) as [string, { path?: string }][])
		// GUI types (Controls, ObjC/Cocoa) are excluded: they need the ObjC
		// frameworks, which cannot live in the precompiled aarch64 system
		// object. They compile in the user TU instead. Stream/Tcp's
		// `aarch64_use_c` bodies ride in the system companion object (linked
		// next to system.o by check_output), so Tcp IS canonical.
		.filter(([, entry]) => !String(entry.path).includes("Controls"))
		.map(([name]) => name)
		.filter((name) => !primitives.has(name));
	const decls = types.map((t) => `\tvar int ${t} = 0`);

	// List/Array handle string elements; the index-buffered containers
	// (Set/Tree/LinkedList/Graph) are instantiated with int only — their
	// Buffer accessors are codegen-named `_int`, so a string element type
	// would mismatch. (Any combo not here is emitted in the user TU.)
	for (const g of ["List", "Array"]) {
		for (const e of ["int", "string", "char", "uint"])
			decls.push(`\tvar ${g}<${e}> _${g}_${e} = ${g}<${e}>()`);
	}
	for (const g of ["Set", "Tree", "LinkedList", "Graph"]) {
		decls.push(`\tvar ${g}<int> _${g}_int = ${g}<int>()`);
	}
	for (const k of ["int", "string"]) {
		for (const v of ["int", "string"])
			decls.push(`\tvar Map<${k},${v}> _map_${k}_${v} = Map<${k},${v}>()`);
	}

	const source = `import System\npub func main = () {\n${decls.join("\n")}\n}\n`;
	return source;
}

function hash_of(...parts: string[]): string {
	const h = crypto.createHash("sha256");
	for (const p of parts) h.update(p);
	return h.digest("hex").slice(0, 16);
}

/**
 * Parse + check the canonical program on a fresh AST. Cheap defensive
 * isolation: `build()` no longer mutates the AST it's given (allocations are
 * deduped via `status.emitted_allocations` instead of cleared, and the
 * aarch64 label counters are reset per build), so reusing one AST across
 * backends would also be sound — but a fresh parse per backend keeps each
 * build independent regardless of future codegen changes.
 */
function parse_canonical(source: string): RootNode {
	const lib = get_library(path.resolve("core"));
	const parsed = parse(source, lib);
	if (parsed.errors.length) {
		throw new Error(
			`canonical System program failed to parse/check:\n${parsed.errors.map((e) => e.message).join("\n")}`,
		);
	}
	return parsed.root;
}

/**
 * Build system.o for both backends if stale (or missing). Returns true if
 * anything (re)built. Idempotent and parallel-safe (atomic temp-then-rename).
 */
export async function ensure_system_lib(audit = true): Promise<boolean> {
	const source = canonical_program();
	const lib_source_hash = current_lib_source_hash();
	let rebuilt = false;
	const c_paths = system_paths("c", audit);
	const a64_paths = system_paths("aarch64", audit);

	// Write the object's library-source marker (atomic temp-then-rename — a
	// test worker may read it for the freshness gate at any moment).
	const write_libhash = (paths: ReturnType<typeof system_paths>): void => {
		const tmp = `${paths.libhash}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		fs.writeFileSync(tmp, lib_source_hash);
		fs.renameSync(tmp, paths.libhash);
	};
	// A WARM object was proven current by its .hash (which hashes the library
	// source), so blessing its marker is safe; on a cold build the marker is
	// written only after the object lands. A failed build leaves the previous
	// marker — stale on a library edit, so the freshness gate (system_lib_fresh)
	// stops pairing the old object with fresh user TUs.
	const ensure_libhash = (paths: ReturnType<typeof system_paths>): void => {
		const present = fs.existsSync(paths.libhash) ? fs.readFileSync(paths.libhash, "utf8") : "";
		if (present !== lib_source_hash) write_libhash(paths);
	};

	// ---------- C backend ----------
	const built_c = build(parse_canonical(source), { arch: "c", audit, emit_mode: "system" });
	const c_struct_names = new Set<string>(
		(Array.from((built_c.headers ?? "").matchAll(/^typedef struct (\w+)/gm)) as RegExpMatchArray[])
			.map((m) => m[1])
			.concat(
				(Array.from(built_c.code.matchAll(/^typedef struct (\w+)/gm)) as RegExpMatchArray[]).map(
					(m) => m[1],
				),
			),
	);
	// Simple/primitive types (int, string, …) have no typedef but their methods
	// ARE in system.o — include them so the user TU doesn't re-emit e.g.
	// int_to_string and clash.
	for (const t of built_in_types) c_struct_names.add(t);
	fs.mkdirSync(path.dirname(c_paths.obj), { recursive: true });
	// Atomic rename: test workers read this file concurrently (it decides
	// what a user TU emits itself vs references from system.o), so a partial
	// write must never be observable.
	const write_names = (file: string, data: string): void => {
		const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, file);
	};
	write_names(SYSTEM_NAMES, JSON.stringify([...c_struct_names], null, "\t") + "\n");

	const c_hash = hash_of(lib_source_hash, built_c.code, built_c.headers ?? "", "c");
	const c_warm =
		c_hash === (fs.existsSync(c_paths.hash) ? fs.readFileSync(c_paths.hash, "utf8") : "") &&
		fs.existsSync(c_paths.obj) &&
		fs.existsSync(c_paths.h);
	if (c_warm) {
		ensure_libhash(c_paths);
	} else {
		// The system TU's code does `#include "main.h"`, so stage its headers there.
		fs.writeFileSync(path.join(path.dirname(c_paths.obj), "main.h"), built_c.headers ?? "");
		fs.writeFileSync(c_paths.src, built_c.code);
		fs.writeFileSync(c_paths.h, built_c.headers ?? "");
		const tmp = `${c_paths.obj}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		try {
			await execPromise(`clang -c ${c_paths.src} -o ${tmp}`, { maxBuffer: 10 * 1024 * 1024 });
			fs.renameSync(tmp, c_paths.obj);
			fs.writeFileSync(c_paths.hash, c_hash);
			ensure_libhash(c_paths);
			rebuilt = true;
		} catch (e) {
			// Mirror the aarch64 fallback below: a failed system build must not
			// leave the PREVIOUS library's object in place — it would pass the
			// object-exists gate and get linked into fresh user TUs (the
			// split-build stale system-object hazard). Remove it so every test
			// falls back to a single TU, and keep going so the aarch64 arm
			// still runs.
			console.error(
				`[system_lib] C system.o build failed — falling back to single-TU:\n${(e as Error).message?.split("\n").slice(0, 4).join("\n")}`,
			);
			try {
				fs.rmSync(tmp, { force: true });
				fs.rmSync(c_paths.obj, { force: true });
			} catch {}
		}
	}

	// ---------- aarch64 backend ----------
	// Fresh AST — see parse_canonical (defensive isolation per backend).
	const built_a64 = build(parse_canonical(source), {
		arch: "aarch64",
		audit,
		emit_mode: "system",
	});
	// Function names exported by the system object: build_function_node,
	// build_struct_node's method export, and the tail interpolate helpers all
	// emit `.globl _name`. Extract from the RAW asm (before postprocess).
	const a64_fn_names = Array.from(built_a64.code.matchAll(/^\.globl _([A-Za-z_]\w*)$/gm)).map(
		(m) => m[1],
	);
	const a64_asm = postprocess_macos(built_a64.code, audit, "aarch64");
	fs.mkdirSync(path.dirname(a64_paths.obj), { recursive: true });
	write_names(SYSTEM_NAMES_A64, JSON.stringify(a64_fn_names, null, "\t") + "\n");

	const a64_companion = built_a64.companion ?? "";
	const a64_hash = hash_of(lib_source_hash, a64_asm, a64_companion, "aarch64");
	const a64_warm =
		a64_hash === (fs.existsSync(a64_paths.hash) ? fs.readFileSync(a64_paths.hash, "utf8") : "") &&
		fs.existsSync(a64_paths.obj) &&
		// The companion is linked next to the object; a build that emits one
		// must not be called warm while its companion is missing (the user
		// link would silently skip it and miss the library use_c bodies).
		(a64_companion.trim().length === 0 || fs.existsSync(a64_paths.companion));
	if (a64_warm) {
		ensure_libhash(a64_paths);
	} else {
		fs.writeFileSync(a64_paths.src, a64_asm);
		const tmp = `${a64_paths.obj}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		try {
			await execPromise(`clang -c -x assembler ${a64_paths.src} -o ${tmp}`, {
				maxBuffer: 10 * 1024 * 1024,
			});
			if (a64_companion.trim().length > 0) {
				const comp_src = path.join(path.dirname(a64_paths.src), "system_companion.m");
				const comp_tmp = `${a64_paths.companion}.tmp.${process.pid}`;
				fs.writeFileSync(comp_src, a64_companion);
				await execPromise(`clang -c ${comp_src} -o ${comp_tmp}`, {
					maxBuffer: 10 * 1024 * 1024,
				});
				fs.renameSync(comp_tmp, a64_paths.companion!);
			}
			fs.renameSync(tmp, a64_paths.obj);
			fs.writeFileSync(a64_paths.hash, a64_hash);
			ensure_libhash(a64_paths);
			rebuilt = true;
		} catch (e) {
			// A pre-existing aarch64 codegen bug (emit_mode "system" loses
			// heap-local `.space 8` definitions) can make the system asm
			// unassembleable in this process. Don't block the suite: aarch64
			// tests fall back to single-TU when the object is absent.
			console.error(
				`[system_lib] aarch64 system.o build failed — falling back to single-TU:\n${(e as Error).message?.split("\n").slice(0, 4).join("\n")}`,
			);
			try {
				fs.rmSync(tmp, { force: true });
				fs.rmSync(a64_paths.obj, { force: true });
			} catch {}
		}
	}

	return rebuilt;
}
