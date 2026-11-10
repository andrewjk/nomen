/**
 * The JavaScript runtime prelude the JS backend prepends to every program.
 *
 * Nomen values map to JS as: every int family → `bigint` (exact 64-bit
 * arithmetic), every float family → `number`, strings and chars → `string`
 * (a char is a one-character string), bool → `boolean`, arrays → JS arrays,
 * structs → plain objects, `null` → `null`. Ownership (`mv`, auto-free) and
 * the audit runtime are compile-time / native-memory concerns with no JS
 * analogue — the GC owns everything here.
 *
 * Only the System-library surface the JS subset supports is provided
 * (`Console`, the `Format` helpers interpolation lowers to, and the string /
 * array methods the backend dispatches). Unsupported library calls surface as
 * a clear runtime error rather than silently wrong output.
 */
export default function runtime(): string {
	return `import { readFileSync } from "node:fs";

const __out = (s) => process.stdout.write(String(s));

// printf "%f" (six decimals). toFixed matches for the magnitudes demos use;
// note the >1e21 divergence (printf keeps expanding, toFixed goes exponent).
function __fmt_f(x) {
	if (Number.isNaN(x)) return "nan";
	if (x === Infinity) return "inf";
	if (x === -Infinity) return "-inf";
	return x.toFixed(6);
}

function __to_string(v) {
	if (typeof v === "string") return v;
	if (typeof v === "bigint") return v.toString();
	if (typeof v === "number") return __fmt_f(v);
	if (typeof v === "boolean") return v ? "true" : "false";
	if (v === null || v === undefined) return "null";
	return String(v);
}

function __render(kind, v) {
	if (kind === "i" || kind === "u") return BigInt(v).toString();
	if (kind === "f") return __fmt_f(Number(v));
	return __to_string(v);
}

// The compiler's interpolation helper: the pattern carries one "%s" per
// argument (literal "%" bytes are copied verbatim — no printf directives).
function __interp(pattern, kinds, ...args) {
	const parts = pattern.split("%s");
	let out = parts[0];
	for (let i = 0; i < args.length; i++) {
		out += __render(kinds[i] || "s", args[i]) + (parts[i + 1] || "");
	}
	return out;
}

function __list_at(list, i) {
	const index = Number(i);
	if (index < 0 || index >= list.length) __panic("index out of range");
	return list[index];
}

function __list_at_or(list, i, fallback) {
	const index = Number(i);
	if (index < 0 || index >= list.length) return fallback;
	return list[index];
}

function __map_get(map, key) {
	if (!map.has(key)) __panic("map key not found");
	return map.get(key);
}

function __sb_take_since(sb, mark) {
	const at = Number(mark);
	const taken = sb.s.slice(at);
	sb.s = sb.s.slice(0, at);
	return taken;
}

function __enum_eq(a, b) {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.$tag !== b.$tag) return false;
	const ka = Object.keys(a).filter((k) => k !== "$tag");
	const kb = Object.keys(b).filter((k) => k !== "$tag");
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (a[k] !== b[k]) return false;
	}
	return true;
}

function __panic(message) {
	process.stderr.write("panic: " + __to_string(message) + "\\n");
	process.exit(2);
}

function __unsupported(what) {
	throw new Error("js backend: unsupported feature: " + what);
}

// --- Console --------------------------------------------------------------

function Console_write(s) { __out(s); }
function Console_write_line(s) { __out(s + "\\n"); }

let __stdin_lines = null;
let __stdin_index = 0;
function __ensure_stdin() {
	if (__stdin_lines !== null) return;
	try {
		__stdin_lines = readFileSync(0, "utf8").split("\\n");
	} catch (e) {
		__stdin_lines = [];
	}
}
function Console_read_line() {
	__ensure_stdin();
	const line = __stdin_lines[__stdin_index] || "";
	__stdin_index++;
	return line;
}
function Console_read_char() {
	__ensure_stdin();
	const line = __stdin_lines[__stdin_index] || "";
	if (line.length === 0) return "";
	__stdin_lines[__stdin_index] = line.slice(1);
	return line[0];
}
function Console_platform() { return "js"; }

// --- Format (the helpers interpolation specs lower to) --------------------

function __pad_to(s, width, zero, signFirst) {
	let w = width;
	let left = false;
	if (w < 0n) { left = true; w = -w; }
	const total = BigInt(s.length);
	if (w <= total) return s;
	const count = Number(w - total);
	if (left) return s + " ".repeat(count);
	if (zero && signFirst) return s[0] + "0".repeat(count) + s.slice(1);
	return (zero ? "0" : " ").repeat(count) + s;
}

function Format_pad(text, width) {
	return __pad_to(text, width, false, false);
}

function __int_digits(mag, base, upper) {
	const digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
	let s = "";
	if (mag === 0n) return "0";
	while (mag > 0n) {
		s = digits[Number(mag % base)] + s;
		mag /= base;
	}
	return s;
}

function __int_base(signed, value, base, upper, width, zero, group) {
	let neg = signed && value < 0n;
	let mag = neg ? -value : value;
	let s = __int_digits(mag, base, upper);
	if (group && base === 10n) s = s.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
	if (neg) s = "-" + s;
	return __pad_to(s, width, zero, neg);
}

function Format_int_base(value, base, upper, width, zero, group) {
	return __int_base(true, value, base, upper, width, zero, group);
}

function Format_uint_base(value, base, upper, width, zero, group) {
	return __int_base(false, value, base, upper, width, zero, group);
}

// A printf float directive built by the checker: %[0][-][width][.places][fFeE]
function Format_float_fixed(value, spec) {
	const m = /^%(0)?(-)?(\\d+)?(?:\\.(\\d+))?([fFeE])$/.exec(spec);
	if (!m) __unsupported("float directive " + spec);
	const zero = !!m[1];
	const left = !!m[2];
	const width = m[3] ? BigInt(m[3]) : 0n;
	const places = m[4] !== undefined ? Number(m[4]) : 6;
	const letter = m[5];
	let body;
	if (letter === "f") {
		body = value.toFixed(places);
	} else {
		body = value.toExponential(places);
		// printf pads the exponent to at least two digits (1.50e+00).
		body = body.replace(/e([+-])(\\d)$/, "e$10$2");
		if (letter === "E") body = body.replace("e", "E");
	}
	if (width === 0n) return body;
	return __pad_to(body, left ? -width : width, zero, false);
}

function Format_float_grouped(value, places) {
	const text = value.toFixed(Number(places));
	const dot = text.indexOf(".");
	const head = dot === -1 ? text : text.slice(0, dot);
	const tail = dot === -1 ? "" : text.slice(dot);
	const grouped = head.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
	return grouped + tail;
}

// Custom patterns are not implemented in the JS backend yet.
function Format_int_pattern() { __unsupported("format patterns"); }
function Format_uint_pattern() { __unsupported("format patterns"); }
function Format_float_pattern() { __unsupported("format patterns"); }

`;
}
