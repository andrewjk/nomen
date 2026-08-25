import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import build from "../src/build";
import built_in_types from "../src/built_in_types";
import { get_library } from "../src/lib";
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
// C backend
export const SYSTEM_OBJ = path.join(SYSTEM_LIB_DIR, "c", "system.o");
export const SYSTEM_H = path.join(SYSTEM_LIB_DIR, "c", "system.h");
const SYSTEM_SRC = path.join(
	SYSTEM_LIB_DIR,
	"c",
	`system${process.platform === "darwin" ? ".m" : ".c"}`,
);
export const SYSTEM_HASH = path.join(SYSTEM_LIB_DIR, "c", ".hash");
/** Struct names defined in system.o (C). Test builds emit any struct NOT in
 *  this set into the user TU, so a generic/tuple the canonical didn't
 *  instantiate (e.g. `Buffer<float>`, `_Tuple_int_string_bool`) is generated
 *  per-test instead of left undefined. */
export const SYSTEM_NAMES = path.join(SYSTEM_LIB_DIR, "c", "names.json");
// aarch64 backend
export const SYSTEM_OBJ_A64 = path.join(SYSTEM_LIB_DIR, "aarch64", "system.o");
const SYSTEM_SRC_A64 = path.join(SYSTEM_LIB_DIR, "aarch64", "system.s");
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
function canonical_program(): { source: string; lib_source_hash: string } {
	const lib = get_library(path.resolve("core"));
	const lib_source_hash = crypto.createHash("sha256").update(lib.source).digest("hex").slice(0, 16);

	// Primitive type names can't be declared as identifiers (they'd collide
	// with the type keyword); they're pulled in via parse.ts BASE_TYPES.
	const primitives = new Set<string>(built_in_types);
	const types = (Array.from(lib.types.entries()) as [string, { path?: string }][])
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
	return { source, lib_source_hash };
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
export async function ensure_system_lib(): Promise<boolean> {
	const { source, lib_source_hash } = canonical_program();
	let rebuilt = false;

	// ---------- C backend ----------
	const built_c = build(parse_canonical(source), { arch: "c", audit: true, emit_mode: "system" });
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
	fs.mkdirSync(path.dirname(SYSTEM_OBJ), { recursive: true });
	fs.writeFileSync(SYSTEM_NAMES, JSON.stringify([...c_struct_names], null, "\t") + "\n");

	const c_hash = hash_of(lib_source_hash, built_c.code, built_c.headers ?? "", "c");
	const c_warm =
		c_hash === (fs.existsSync(SYSTEM_HASH) ? fs.readFileSync(SYSTEM_HASH, "utf8") : "") &&
		fs.existsSync(SYSTEM_OBJ) &&
		fs.existsSync(SYSTEM_H);
	if (!c_warm) {
		// The system TU's code does `#include "main.h"`, so stage its headers there.
		fs.writeFileSync(path.join(path.dirname(SYSTEM_OBJ), "main.h"), built_c.headers ?? "");
		fs.writeFileSync(SYSTEM_SRC, built_c.code);
		fs.writeFileSync(SYSTEM_H, built_c.headers ?? "");
		const tmp = `${SYSTEM_OBJ}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		await execPromise(`clang -c ${SYSTEM_SRC} -o ${tmp}`, { maxBuffer: 10 * 1024 * 1024 });
		fs.renameSync(tmp, SYSTEM_OBJ);
		fs.writeFileSync(SYSTEM_HASH, c_hash);
		rebuilt = true;
	}

	// ---------- aarch64 backend ----------
	// Fresh AST — see parse_canonical (defensive isolation per backend).
	const built_a64 = build(parse_canonical(source), {
		arch: "aarch64",
		audit: true,
		emit_mode: "system",
	});
	// Function names exported by the system object: build_function_node,
	// build_struct_node's method export, and the tail interpolate helpers all
	// emit `.globl _name`. Extract from the RAW asm (before postprocess).
	const a64_fn_names = Array.from(built_a64.code.matchAll(/^\.globl _([A-Za-z_]\w*)$/gm)).map(
		(m) => m[1],
	);
	const a64_asm = postprocess_macos(built_a64.code, true, "aarch64");
	fs.mkdirSync(path.dirname(SYSTEM_OBJ_A64), { recursive: true });
	fs.writeFileSync(SYSTEM_NAMES_A64, JSON.stringify(a64_fn_names, null, "\t") + "\n");

	const a64_hash = hash_of(lib_source_hash, a64_asm, "aarch64");
	const a64_warm =
		a64_hash === (fs.existsSync(SYSTEM_HASH_A64) ? fs.readFileSync(SYSTEM_HASH_A64, "utf8") : "") &&
		fs.existsSync(SYSTEM_OBJ_A64);
	if (!a64_warm) {
		fs.writeFileSync(SYSTEM_SRC_A64, a64_asm);
		const tmp = `${SYSTEM_OBJ_A64}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		try {
			await execPromise(`clang -c -x assembler ${SYSTEM_SRC_A64} -o ${tmp}`, {
				maxBuffer: 10 * 1024 * 1024,
			});
			fs.renameSync(tmp, SYSTEM_OBJ_A64);
			fs.writeFileSync(SYSTEM_HASH_A64, a64_hash);
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
				fs.rmSync(SYSTEM_OBJ_A64, { force: true });
			} catch {}
		}
	}

	return rebuilt;
}
