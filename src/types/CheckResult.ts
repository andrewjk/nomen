import type CompileError from "./CompileError";

export default interface CheckResult {
  ok: boolean;
  errors: CompileError[];
}
