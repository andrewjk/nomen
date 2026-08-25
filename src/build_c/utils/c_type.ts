import { built_in_c_type } from "../../built_in_types.ts";

// When the C backend's single translation unit also `#import`s Apple's
// Foundation/Cocoa/UIKit frameworks (any GUI build — see `build_needs_objc` in
// build.ts), MacTypes.h defines typedefs like `Size`/`Point`/`Rect` that would
// collide with Nomen's own `typedef struct Size {...} Size;`. Mirroring the
// aarch64 companion's `nm_` strategy (c_companion.ts), user-defined
// struct/enum TYPEDEF names are then prefixed with `nm_` while the struct TAG
// (used by `struct Foo`, raw `#arch` blocks, and field layouts) stays
// unchanged — tags live in a separate C namespace from MacTypes' typedefs, so
// `struct Size` and `typedef unsigned long Size` coexist.
//
// This flag is set once per build by build.ts. It is OFF for every non-GUI
// program, so the entire non-GUI C codegen is byte-for-byte unchanged.
let mangle_typedefs = false;

export function set_c_typedef_mangling(on: boolean): void {
	mangle_typedefs = on;
}

// Raw #arch bodies written against the thin char* string ABI are emitted
// under a `_raw_` name with string types rendered thin (see
// raw_string_abi.ts); the compiler-generated adapter carries the fat
// nomen_string signature. Toggled around those emissions only.
let thin_strings = false;

export function set_c_thin_strings(on: boolean): void {
	thin_strings = on;
}

/**
 * The mangled-or-plain TYPEDEF identifier for a user-defined struct/enum name.
 * Used at both the typedef definition site (`typedef struct Foo {...} <here>;`)
 * and at every typedef reference (`<here> x;`). Callers that need the struct
 * TAG instead must use the literal name directly (`struct ${name}`), never this
 * helper — the tag is never mangled.
 *
 * Compiler-internal synthetic types whose names start with `_` (notably tuples
 * `_Tuple_T_U`, which are emitted as tag-only `struct _Tuple_T_U` with no
 * typedef) are never mangled: they don't collide with MacTypes and have no
 * mangled definition to match.
 */
export function c_typedef_name(name: string): string {
	return mangle_typedefs && !name.startsWith("_") ? "nm_" + name : name;
}

export default function c_type(type: string): string {
	switch (type) {
		case "string":
			// Fat string: a 16-byte { char* ptr; long len; } value (see the
			// nomen_string typedef in build.ts's prelude). The buffer is always
			// NUL-terminated at ptr[len] so libc/FFI consumers (printf %s,
			// fopen, stringWithUTF8String:) keep working unchanged; `.length`
			// is a field load, never strlen. Raw #arch bodies still see a thin
			// char* — build_function_node/build_struct_node emit them under a
			// mangled `_raw_` name with a marshalling adapter (see
			// raw_string_abi.ts).
			return thin_strings ? "char*" : "nomen_string";
		case "func":
			return "void*";
		case "void":
			return "void";
		case "null":
			return "void*";
		default: {
			// Static built-in scalars come straight from the shared type table
			// (built_in_types.ts) so declarations can never drift from the raw-
			// block T substitution or from aarch64 layout.
			const mapped = built_in_c_type(type);
			if (mapped) return mapped;
			return c_typedef_name(type);
		}
	}
}
