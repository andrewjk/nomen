export default function c_char_literal(value: string): string {
	const code = value.charCodeAt(1);
	if (code === 92) return `'\\\\'`;
	if (code === 39) return `'\\''`;
	if (code === 10) return `'\\n'`;
	if (code === 13) return `'\\r'`;
	if (code === 9) return `'\\t'`;
	if (code < 0x20 || code > 0x7e) return `'\\x${code.toString(16)}'`;
	return value;
}
