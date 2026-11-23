export default interface Token {
	value: string;
	i: number;
	/**
	 * For `file_marker` tokens only: the absolute path following the
	 * `// file://` marker. The joiner and the library builder inject one
	 * marker before each concatenated file so the parser can attribute
	 * declarations to the file — and namespace — they came from
	 * (docs/SCOPING.md).
	 */
	file?: string;
}
