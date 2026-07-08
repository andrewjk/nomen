/**
 * Maps an Echo function/variable name to a C-safe name. Echo allows names that
 * collide with C keywords (e.g. `double`, `abs`) or C stdlib symbols, so we
 * prefix them with `_echo_` to avoid conflicts.
 */
const C_CONFLICTS = new Set([
	// C keywords
	"auto",
	"break",
	"case",
	"char",
	"const",
	"continue",
	"default",
	"do",
	"double",
	"else",
	"enum",
	"extern",
	"float",
	"for",
	"goto",
	"if",
	"inline",
	"int",
	"long",
	"register",
	"restrict",
	"return",
	"short",
	"signed",
	"sizeof",
	"static",
	"struct",
	"switch",
	"typedef",
	"union",
	"unsigned",
	"void",
	"volatile",
	"while",
	"_Bool",
	"_Complex",
	"_Imaginary",
	// C stdlib functions that might conflict
	"abs",
	"exit",
	"atexit",
	"abort",
	"atoi",
	"atof",
	"atol",
	"getchar",
	"putchar",
	"puts",
	"gets",
	"system",
	"rand",
	"srand",
	// Objective-C reserved identifiers (the C backend emits .m files compiled
	// in ObjC mode, where these are built-in types/keywords).
	"id",
	"SEL",
	"IMP",
	"BOOL",
	"nil",
	"Nil",
	"YES",
	"NO",
	"super",
	"autoreleasepool",
	"description",
]);

export default function c_function_name(name: string): string {
	if (C_CONFLICTS.has(name)) {
		return `_echo_${name}`;
	}
	return name;
}
