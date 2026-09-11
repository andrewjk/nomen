import decode_char_literal from "../../build_common/decode_char_literal.ts";

export default function c_char_literal(value: string): string {
	const code = decode_char_literal(value);
	if (code === undefined) return value;
	if (code === 92) return `'\\\\'`;
	if (code === 39) return `'\\''`;
	if (code === 10) return `'\\n'`;
	if (code === 13) return `'\\r'`;
	if (code === 9) return `'\\t'`;
	if (code < 0x20 || code > 0x7e) return `'\\x${code.toString(16)}'`;
	return `'${String.fromCharCode(code)}'`;
}
