/**
 * Words the parser treats as keywords. A superset of the formatter's keyword
 * list: it also reserves the literals (`true`, `false`, `null`) and `self`,
 * which can never be used as a name.
 */
export const KEYWORDS = new Set([
	"pub",
	"private",
	"struct",
	"class",
	"trait",
	"enum",
	"bitset",
	"extend",
	"func",
	"var",
	"const",
	"mov",
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
	"spawn",
	"async",
	"panic",
	"todo",
	"let",
	"as",
	"swap",
	"raw",
]);

/** Every word that cannot be used as a declared name. */
export const RESERVED_WORDS = new Set([...KEYWORDS, "true", "false", "null", "self"]);
