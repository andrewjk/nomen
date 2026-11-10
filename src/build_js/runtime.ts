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

function __string_at(text, i) {
	const index = Number(i);
	if (index < 0 || index >= text.length) __panic("index out of range");
	return text.at(index);
}

function __string_at_or(text, i, fallback) {
	const index = Number(i);
	if (index < 0 || index >= text.length) return fallback;
	return text.at(index);
}

function __char_code_at_or(text, i, fallback) {
	const index = Number(i);
	if (index < 0 || index >= text.length) return fallback;
	return BigInt(text.charCodeAt(index));
}

function __math_power(base, exp) {
	let result = 1n;
	let n = exp;
	while (n > 0n) {
		result = result * base;
		n = n - 1n;
	}
	return result;
}

function __dispatch(self, name, ...args) {
	const table = self && self.$type;
	const fn = table && table[name];
	if (!fn) __unsupported("trait method " + name);
	return fn(self, ...args);
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

// --- Custom patterns (#,##0.00, 0.0%, #,##0.00;(#,##0.00)) ----------

function __pat_sections(pattern) {
	let quoted = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (quoted) {
			if (c === "'") quoted = false;
		} else if (c === "'") {
			quoted = true;
		} else if (c === ";") {
			return [pattern.slice(0, i), pattern.slice(i + 1)];
		}
	}
	return [pattern, null];
}

function __pat_has_percent(pattern) {
	let quoted = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (quoted) {
			if (c === "'") quoted = false;
		} else if (c === "'") {
			quoted = true;
		} else if (c === "%") {
			return true;
		}
	}
	return false;
}

function __pat_max_frac(pattern) {
	let quoted = false;
	let inFrac = false;
	let count = 0;
	let best = 0;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (quoted) {
			if (c === "'") quoted = false;
			continue;
		}
		if (c === "'") { quoted = true; continue; }
		if (c === ";") { inFrac = false; count = 0; continue; }
		if (c === ".") { inFrac = true; continue; }
		if (c === "0" || c === "#") {
			if (inFrac) {
				count += 1;
				if (count > best) best = count;
			}
			continue;
		}
		inFrac = false;
		count = 0;
	}
	return best;
}

function __pat_shape_int(intDigits, padSlots, hasComma, groupSize) {
	let digits = intDigits;
	if (digits === "0" && padSlots === 0) return "";
	if (digits.length < padSlots) digits = "0".repeat(padSlots - digits.length) + digits;
	if (hasComma && groupSize > 0 && digits.length > groupSize) {
		digits = digits.replace(new RegExp("\\\\B(?=(\\\\d{" + groupSize + "})+(?!\\\\d))", "g"), ",");
	}
	return digits;
}

function __pat_shape_frac(fracRaw, fracSlots, fracMin) {
	let kept = fracRaw.length > fracSlots ? fracRaw.slice(0, fracSlots) : fracRaw;
	let n = kept.length;
	while (n > fracMin) {
		if (kept[n - 1] === "0") n -= 1;
		else { n = fracMin; break; }
	}
	kept = kept.slice(0, n);
	if (kept.length < fracMin) kept += "0".repeat(fracMin - kept.length);
	return kept;
}

function __pat_render(section, intDigits, fracRaw, negative) {
	let quoted = false;
	let firstSlot = -1;
	let lastSlot = -1;
	let dot = -1;
	let padSlots = 0;
	let fracSlots = 0;
	let fracMin = 0;
	let hasComma = false;
	let slotsAfterComma = 0;

	for (let i = 0; i < section.length; i++) {
		const c = section[i];
		if (quoted) { if (c === "'") quoted = false; continue; }
		if (c === "'") { quoted = true; continue; }
		if (c === "." && dot === -1) dot = i;
		if (c === "0" || c === "#") {
			lastSlot = i;
			if (dot === -1) {
				if (firstSlot === -1) firstSlot = i;
				slotsAfterComma += 1;
				if (c === "0") padSlots += 1;
			} else {
				fracSlots += 1;
				if (c === "0") fracMin = fracSlots;
			}
		}
		if (c === "," && dot === -1) { hasComma = true; slotsAfterComma = 0; }
	}

	let out = negative ? "-" : "";
	quoted = false;
	for (let i = 0; i < firstSlot; i++) {
		const c = section[i];
		if (quoted) {
			if (c === "'") quoted = false;
			else out += c;
		} else if (c === "'") {
			quoted = true;
		} else {
			out += c;
		}
	}

	out += __pat_shape_int(intDigits, padSlots, hasComma, slotsAfterComma);
	const kept = __pat_shape_frac(fracRaw, fracSlots, fracMin);
	if (kept.length > 0) out += "." + kept;

	quoted = false;
	for (let i = lastSlot + 1; i < section.length; i++) {
		const c = section[i];
		if (quoted) {
			if (c === "'") quoted = false;
			else out += c;
		} else if (c === "'") {
			quoted = true;
		} else if (i !== dot) {
			out += c;
		}
	}
	return out;
}

function __pat_apply(pattern, negative, intDigits, fracRaw) {
	const [positive, negativeSection] = __pat_sections(pattern);
	if (negative && negativeSection !== null) {
		return __pat_render(negativeSection, intDigits, fracRaw, false);
	}
	return __pat_render(positive, intDigits, fracRaw, negative);
}

function Format_int_pattern(value, pattern) {
	let negative = value < 0n;
	let mag = negative ? -value : value;
	if (__pat_has_percent(pattern)) mag = mag * 100n;
	return __pat_apply(pattern, negative, mag.toString(), "");
}

function Format_uint_pattern(value, pattern) {
	let mag = value;
	if (__pat_has_percent(pattern)) mag = mag * 100n;
	return __pat_apply(pattern, false, mag.toString(), "");
}

function Format_float_pattern(value, pattern) {
	let negative = value < 0;
	let mag = negative ? -value : value;
	if (__pat_has_percent(pattern)) mag = mag * 100;
	const maxFrac = __pat_max_frac(pattern);
	const rendered = mag.toFixed(maxFrac);
	const dot = rendered.indexOf(".");
	const intDigits = dot === -1 ? rendered : rendered.slice(0, dot);
	const frac = dot === -1 ? "" : rendered.slice(dot + 1);
	return __pat_apply(pattern, negative, intDigits, frac);
}

`;
}
