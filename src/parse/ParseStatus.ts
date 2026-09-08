import BaseNode from "../nodes/BaseNode.ts";
import type CompileError from "../types/CompileError.ts";
import type Token from "../types/Token.ts";

export default interface ParseStatus {
	/**
	 * Tokens extracted from source code
	 */
	tokens: Token[];
	/**
	 * The current token index
	 */
	i: number;
	/**
	 * The current node
	 */
	stack: BaseNode[];
	/**
	 * The current namespace
	 */
	namespace: string;
	/**
	 * Namespace-qualified paths seen in the source (`System::Controls::Button`),
	 * recorded for post-parse validation against the library namespace index.
	 */
	qualified_paths: { segments: string[]; start: number }[];
	/**
	 * Errors that have been encountered
	 */
	errors: CompileError[];
}
