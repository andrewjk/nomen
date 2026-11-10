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
export type JsTarget = "node" | "browser";

export default function runtime(target: JsTarget = "node"): string {
	// The prelude differs only in how the program reaches the outside world.
	// `node` writes to the process streams; `browser` hands output to a host
	// hook (`globalThis.__nomen_write`) so a REPL can capture it, and turns
	// `exit` into a throw the host can catch.
	const header =
		target === "browser"
			? `const __out = (s) => {
	const write = globalThis.__nomen_write;
	if (write) write(String(s));
	else console.log(String(s));
};
const __stderr = (s) => {
	const write = globalThis.__nomen_write;
	if (write) write(String(s));
	else console.error(String(s));
};
const __read_stdin = () => "";
const __exit = (code) => {
	throw new Error("__nomen_exit:" + code);
};`
			: `import { readFileSync } from "node:fs";

const __out = (s) => process.stdout.write(String(s));
const __stderr = (s) => process.stderr.write(String(s));
const __read_stdin = () => {
	try {
		return readFileSync(0, "utf8");
	} catch (e) {
		return "";
	}
};
const __exit = (code) => process.exit(code);`;

	return `${header}

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
	// An enum renders as its tag (the native backends delegate enum
	// to_string to the int tag; a bitset is already a bigint).
	if (typeof v === "object" && typeof v.$tag === "number") return String(v.$tag);
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

function __sleep_ms(ms) {
	const wait = Number(ms);
	if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

function __string_hash(text) {
	let h = 5381n;
	for (const ch of text) h = BigInt.asUintN(64, h * 33n + BigInt(ch.charCodeAt(0)));
	return h;
}

function __char_from_code(code) {
	return String.fromCharCode(Number(code) & 0xff);
}

function __utf8_decode(text, index) {
	const i = Number(index);
	if (i < 0 || i >= text.length) __panic("byte index out of range");
	const cp = text.codePointAt(i);
	const width = cp > 0xffff ? 2 : 1;
	return { code_point: BigInt(cp), byte_length: BigInt(width) };
}

function __utf8_encode(code_point) {
	let cp = Number(code_point);
	if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
	return String.fromCodePoint(cp);
}

function __parse_int(text) {
	if (typeof text !== "string" || !/^[+-]?[0-9]+$/.test(text)) __panic("invalid int: " + text);
	return BigInt(text);
}

function __dispatch(self, name, ...args) {
	const table = self && self.$type;
	const fn = table && table[name];
	if (!fn) __unsupported("trait method " + name);
	return fn(self, ...args);
}

function __set_get(set, value) {
	if (!set.has(value)) __panic("set value not found");
	return set.get(value);
}

function __array_with(value, count) {
	const n = Number(count);
	const out = [];
	for (let i = 0; i < n; i++) out.push(value);
	return out;
}

// --- Buffer (a JS array stands in for the native slab) --------------------

// 128/64 unsigned division (BigInt.div128): the native form saturates when
// the high word is at least the divisor.
function __div128(hi, lo, d) {
	const h = BigInt.asUintN(64, BigInt(hi));
	const l = BigInt.asUintN(64, BigInt(lo));
	const divisor = BigInt.asUintN(64, BigInt(d));
	if (h >= divisor) return 18446744073709551615n;
	return ((h << 64n) | l) / divisor;
}

function __buffer_alloc(buf, size, zero) {
	const n = Number(size);
	buf.length = 0;
	if (n > 0) buf.length = n;
	buf.fill(zero);
	return BigInt(n);
}

function __buffer_grow(buf, needed, zero) {
	const n = Number(needed);
	if (buf.length >= n) return BigInt(buf.length);
	const old = buf.length;
	buf.length = n;
	for (let i = old; i < n; i++) buf[i] = zero;
	return BigInt(n);
}

function __buffer_move(buf, i) {
	const index = Number(i);
	const value = buf[index];
	buf[index] = undefined;
	return value;
}

function __buffer_shift(buf, dst, src) {
	const d = Number(dst);
	const s = Number(src);
	if (d === s) return;
	buf[d] = buf[s];
	buf[s] = undefined;
}

function __buffer_move_range(buf, dst, src, count) {
	const d = Number(dst);
	const s = Number(src);
	const n = Number(count);
	if (n <= 0) return;
	for (let i = 0; i < n; i++) buf[d + i] = buf[s + i];
	// Zero the source slots the destination does not cover.
	for (let i = d + n; i < s + n; i++) buf[i] = undefined;
}

function __buffer_modify(buf, i, f) {
	const index = Number(i);
	const value = f(buf[index]);
	buf[index] = value;
	return value;
}

function __buffer_zero(buf, len, zero) {
	const n = Number(len);
	for (let i = 0; i < n && i < buf.length; i++) buf[i] = zero;
}

// --- Concurrency, run synchronously --------------------------------------
// There is no scheduler here: a started task runs its thunk to completion
// before start() returns, and the returned Task already holds the result.

// Trait dispatch reads the concrete value's $type table, so the synthesized
// values carry the methods their traits declare.
const __spawn_methods = {
	start: (self) => __spawn_start(self),
	detach: (self) => __spawn_detach(self),
};

const __task_methods = {
	wait: () => {},
	result: (self) => __task_result(self),
	result_uint64: (self) => __task_result_uint64(self),
	is_done: () => true,
	cancel: () => {},
	current_cancelled: () => false,
};

function __spawn_start(thread) {
	if (!thread.started) {
		thread.started = true;
		if (typeof thread.__task === "function") thread.__result = thread.__task();
		thread.__done = true;
	}
	return {
		__result: thread.__result,
		__zero: thread.__zero,
		__done: true,
		__consumed: false,
		$type: __task_methods,
	};
}

function __spawn_detach(thread) {
	__spawn_start(thread);
}

function __nursery_start(nursery, thread) {
	return __spawn_start(thread);
}

function __task_wait(task) {}

function __task_result(task) {
	if (task.__consumed) return task.__zero;
	task.__consumed = true;
	return task.__result === undefined ? task.__zero : task.__result;
}

function __task_result_uint64(task) {
	const value = __task_result(task);
	return value === undefined ? 0n : BigInt(value);
}

function __channel_send(channel, value) {
	channel.values.push(value);
}

function __channel_send_string(channel, value) {
	channel.strings.push(String(value));
}

function __channel_receive(channel) {
	return channel.values.length ? channel.values.shift() : 0n;
}

function __channel_receive_string(channel) {
	return channel.strings.length ? channel.strings.shift() : "";
}

function __atomic_fetch_add(atomic, value) {
	const previous = atomic.word;
	atomic.word = BigInt.asUintN(64, BigInt(previous) + BigInt(value));
	return previous;
}

function __atomic_swap(atomic, value) {
	const previous = atomic.word;
	atomic.word = value;
	return previous;
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

// Nomen value structs are copied on binding, assignment, return, container
// store, and closure capture. JS objects are by reference, so the builders
// wrap those transfers in this deep clone.
function __copy(value) {
	if (Array.isArray(value)) return value.map(__copy);
	if (value instanceof Map) return new Map([...value].map(([k, v]) => [__copy(k), __copy(v)]));
	if (value instanceof Set) return new Set([...value].map(__copy));
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value)) out[key] = __copy(value[key]);
		return out;
	}
	return value;
}

function __enum_to_case(value, tag, name) {
	if (!value || value.$tag !== tag) {
		__panic("base to case conversion: the value carries a different variant (" + name + ")");
	}
	return value;
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
	__stderr("panic: " + __to_string(message) + "\\n");
	__exit(2);
}

function __unsupported(what) {
	throw new Error("js backend: unsupported feature: " + what);
}

// A library feature the JS backend cannot express (raw memory, GUI, threads).
// Cross-compiled programs keep running without it: warn once per feature and
// let the caller see the statement's zero value.
const __skipped = new Set();
function __skip(what) {
	if (!__skipped.has(what)) {
		__skipped.add(what);
		__stderr("js backend: skipping unavailable feature: " + what + "\\n");
	}
	return undefined;
}

// --- Console --------------------------------------------------------------

function Console_write(s) { __out(s); }
function Console_write_line(s) { __out(s + "\\n"); }

let __stdin_lines = null;
let __stdin_index = 0;
function __ensure_stdin() {
	if (__stdin_lines !== null) return;
	try {
		__stdin_lines = __read_stdin().split("\\n");
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
