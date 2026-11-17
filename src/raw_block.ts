/**
 * Shared scanning for raw blocks — `#raw` / `#raw("c")` / `#raw(…, "file")`.
 *
 * A raw body is delimited by braces, but the braces that CLOSE it are the
 * ones outside C/asm strings and comments: hand-written code routinely
 * carries `{`/`}` inside `//` notes (`// release it { … }`) and ObjC type
 * encodings (`"v@:@@{NSSize=dd}"`), and a naive counter would end the block
 * in the wrong place. Both the tokenizer (which turns the body into one
 * token) and the formatter (which leaves raw lines verbatim) share this
 * scan so they can never disagree about where a block ends.
 */

/**
 * Index of the `}` closing a raw body that starts at `from` (the character
 * just past the opening brace), or `input.length` when unterminated.
 *
 * Strings (`"…"`, `'…'`) and both comment forms are stepped over; a string
 * that reaches end-of-line is treated as terminated there (C strings cannot
 * span lines unescaped — an unterminated literal must not swallow the rest
 * of the block).
 */
export function scan_raw_body_end(input: string, from: number): number {
	let depth = 1;
	let i = from;
	while (i < input.length) {
		const c = input[i];
		if (c === '"' || c === "'") {
			const quote = c;
			i++;
			while (i < input.length) {
				if (input[i] === "\\") {
					i += 2;
					continue;
				}
				if (input[i] === quote) {
					i++;
					break;
				}
				if (input[i] === "\n") break;
				i++;
			}
			continue;
		}
		if (c === "/" && input[i + 1] === "/") {
			while (i < input.length && input[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && input[i + 1] === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === "{") {
			depth++;
		} else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return input.length;
}

/** Whether `input` at `i` begins a `#raw` directive (word-boundary check). */
export function is_raw_directive_at(input: string, i: number): boolean {
	return input.startsWith("#raw", i) && /[\s({]/.test(input[i + 4] ?? " ");
}
