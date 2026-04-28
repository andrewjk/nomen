import type CompileError from "./CompileError.ts";

export default interface CompileResult {
	ok: boolean;
	headers: string;
	code: string;
	errors: CompileError[];
}
