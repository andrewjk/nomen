import type CompileError from "./CompileError";

export default interface CompileResult {
  ok: boolean;
  headers: string;
  code: string;
  errors: CompileError[];
}
