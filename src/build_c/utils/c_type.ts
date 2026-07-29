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
		case "bool":
			return "unsigned char";
		case "int":
			return "long";
		case "uint":
			return "unsigned long";
		case "int8":
			return "char";
		case "uint8":
			return "unsigned char";
		case "int16":
			return "short";
		case "uint16":
			return "unsigned short";
		case "int32":
			return "int";
		case "uint32":
			return "unsigned int";
		case "int64":
			return "long long";
		case "uint64":
			return "unsigned long long";
		case "float":
			// Nomen `float` is 8 bytes on aarch64 (see aarch64_size.ts), so the C
			// backend must use `double` to match struct layout and arithmetic
			// precision. Using C `float` (4 bytes) causes checksum/energy drift.
			return "double";
		case "ufloat":
			return "double";
		case "float32":
			return "double";
		case "ufloat32":
			return "double";
		case "float64":
			return "double";
		case "ufloat64":
			return "double";
		case "char":
			// TODO:
			return "char";
		case "string":
			return "char*";
		case "func":
			return "void*";
		case "void":
			return "void";
		case "null":
			return "void*";
		default:
			return c_typedef_name(type);
	}
}
