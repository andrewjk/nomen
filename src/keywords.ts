/**
 * Words the parser treats as keywords. A superset of the formatter's keyword
 * list: it also reserves the literals (`true`, `false`, `null`) and `self`,
 * which can never be used as a name.
 */
export const KEYWORDS = new Set([
	"pub",
	"private",
	"internal",
	"readonly",
	"struct",
	// Retired (STRUCT_PLAN_3 Phase R) but kept a keyword so `class X { … }`
	// lexes for the parser's dedicated retirement error instead of cascading
	// through the expression path.
	"class",
	"trait",
	"enum",
	"bitset",
	"extend",
	"func",
	"var",
	"const",
	"move",
	"ref",
	"cp",
	"out",
	"in",
	"view",
	"import",
	"return",
	"if",
	"else",
	"switch",
	"match",
	"case",
	"for",
	"of",
	"while",
	"break",
	"continue",
	"async",
	"panic",
	"todo",
	"let",
	"as",
	"swap",
	"extern",
	"unsafe",
]);

/** Every word that cannot be used as a declared name. */
export const RESERVED_WORDS = new Set([...KEYWORDS, "true", "false", "null", "self"]);
