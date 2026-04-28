import type CompileError from "./CompileError.ts";

export default interface CheckResult {
	ok: boolean;
	errors: CompileError[];
}
