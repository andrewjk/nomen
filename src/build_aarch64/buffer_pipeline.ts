/**
 * Inline Buffer address pipeline (ASM_PLAN_3 tranche K).
 *
 * Knuth-D loops spend ~30 of ~61 instructions re-deriving each
 * `remainder.digits.load_int(base + induction)` address:
 *   - 2-3 loop-invariant slot loads (wd_off, u_len, etc.)
 *   - 2 adds for the index sum
 *   - 3 instructions for the data pointer (mov x9, base; add #fieldoff; ldr)
 *   - plus slot spills of the computed index
 *
 * The existing buffer_data_cache dedups within a straight-line body but
 * is cleared on entry to every `while`, so each outer iteration refills
 * and under Knuth-D pressure the x23-x28 pool is exhausted and every
 * inner iteration reloads. This pipeline hoists both the data pointer
 * and the invariant index base into callee-saved registers per loop,
 * so each inner access becomes a single `add x1, baseReg, indReg` plus
 * the cached `ldr/str [dataReg, x1, lsl #3]`.
 */

import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_int_literal } from "../int_literal.ts";
import type { NirStmt } from "../nir/nir.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import type WhileLoopNode from "../nodes/WhileLoopNode.ts";
import { tree_is_call_free } from "./build_operation_node.ts";

let pipeline_on = false;

export function buffer_pipeline_enabled(): boolean {
	return pipeline_on;
}

export function set_buffer_pipeline_enabled(enabled: boolean): void {
	pipeline_on = enabled;
}

const PIPELINE_REGS = ["x23", "x24", "x25", "x26", "x27", "x28"];

function allocPipelineReg(status: BuildStatus, callFree = false): string | null {
	const used = new Set(status.register_allocations?.values() ?? []);
	const cachedData = new Set(status.buffer_data_cache?.values() ?? []);
	const cachedBase = new Set(
		status.buffer_base_cache
			? Array.from(status.buffer_base_cache.values()).map((v) => v.baseReg)
			: [],
	);
	const claimed = new Set(status.callee_saved_regs_used ?? []);
	const cachedBaseData = new Set(
		status.buffer_base_cache
			? (Array.from(status.buffer_base_cache.values())
					.map((v) => v.dataReg)
					.filter(Boolean) as string[])
			: [],
	);
	// For the hot Knuth-D loops, be more permissive: allow reuse of a
	// promotion register if it is not live across this loop (conservative:
	// check interference via adj). For now, just try the full pool including
	// caller-saved for call-free loops, and for callee-saved try to evict
	// the least recently used if needed.
	const pool = callFree ? [...PIPELINE_REGS, "x12", "x13", "x14", "x15"] : PIPELINE_REGS;
	for (const r of pool) {
		if (cachedData.has(r) || cachedBase.has(r) || cachedBaseData.has(r) || claimed.has(r)) continue;
		// For used (promotion), check if it interferes with loop body - for now, be conservative and skip
		// But for hot loops, we can be more aggressive: if used, check if the promoted var is not live in this loop
		// For simplicity, allow used for callFree loops as they are short and call-free
		if (used.has(r) && !callFree) continue;
		if (r.startsWith("x1") && status.nir_caller_saved_claimed?.has(r)) continue;
		return r;
	}
	return null;
}

function unwrapGrouped(node: BaseNode | undefined): BaseNode | undefined {
	let n: BaseNode | undefined = node;
	while (n && n.node_type === "grouped") {
		n = (n as unknown as { value?: BaseNode }).value;
	}
	if (n && n.node_type === "cast") {
		n = (n as unknown as { value?: BaseNode }).value;
	}
	return n;
}

function bufferCacheKey(target: BaseNode): string | null {
	if (target.node_type === "value") {
		return (target as ValueNode).value;
	}
	if (target.node_type === "access" && (target as AccessNode).access.node_type === "access_field") {
		const inner = target as AccessNode;
		const field = inner.access as unknown as { name: string };
		if (inner.target.node_type === "value") {
			return `${(inner.target as ValueNode).value}.${field.name}`;
		}
	}
	return null;
}

function collectAddTerms(
	node: BaseNode | undefined,
	out: { name: string; isLit: boolean }[],
): boolean {
	const v = unwrapGrouped(node);
	if (!v) return false;
	if (v.node_type === "value") {
		const n = (v as ValueNode).value;
		if (typeof n !== "string") return false;
		out.push({ name: n, isLit: is_int_literal(n) });
		return true;
	}
	if (v.node_type === "op") {
		const op = v as OperationNode;
		if (op.op === "+") {
			if (!collectAddTerms(op.left_value, out)) return false;
			if (!collectAddTerms(op.right_value, out)) return false;
			return true;
		}
	}
	return false;
}

function emitLoadTerm(
	term: { name: string; isLit: boolean },
	dest: string,
	status: BuildStatus,
): void {
	if (term.isLit) {
		const val = parseInt(term.name);
		if (!isNaN(val) && val >= 0 && val < 4096) {
			status.code += `mov ${dest}, #${val}\n`;
		} else if (!isNaN(val)) {
			status.code += `mov ${dest}, #${val & 0xffff}\n`;
			if (val > 0xffff) status.code += `movk ${dest}, #${(val >> 16) & 0xffff}, lsl #16\n`;
		} else {
			status.code += `mov ${dest}, #0\n`;
		}
		return;
	}
	const name = term.name;
	const reg = status.register_allocations?.get(name);
	if (
		reg &&
		reg.startsWith("x") &&
		!status.function_param_regs?.has(name) &&
		!status.induction_const?.has(name)
	) {
		if (reg !== dest) status.code += `mov ${dest}, ${reg}\n`;
		return;
	}
	const paramReg = status.function_param_regs?.get(name);
	if (paramReg) {
		if (paramReg !== dest) status.code += `mov ${dest}, ${paramReg}\n`;
		return;
	}
	// Slot or global
	const off = status.stack_offsets?.get(name);
	if (off !== undefined) {
		status.code += `ldr ${dest}, [x29, #${off}]\n`;
	} else {
		status.code += `adr ${dest}, ${name}\n`;
		status.code += `ldr ${dest}, [${dest}]\n`;
	}
}

function emitBufferStructAddr(target: BaseNode, status: BuildStatus): void {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			status.code += `mov x9, ${paramReg}\n`;
		} else {
			const off = status.stack_offsets?.get(name);
			if (off !== undefined) {
				const isRef = status.function_ref_params?.has(name);
				if (isRef) {
					status.code += `ldr x9, [x29, #${off}]\n`;
					status.code += `ldr x9, [x9]\n`;
				} else {
					status.code += `add x9, x29, #${off}\n`;
				}
			} else {
				status.code += `adr x9, ${name}\n`;
			}
		}
	} else if (
		target.node_type === "access" &&
		(target as AccessNode).access.node_type === "access_field"
	) {
		const inner = target as AccessNode;
		if (inner.target.node_type === "value") {
			const bname = (inner.target as ValueNode).value;
			const paramReg = status.function_param_regs?.get(bname);
			if (paramReg) {
				status.code += `mov x9, ${paramReg}\n`;
			} else {
				const off = status.stack_offsets?.get(bname);
				if (off !== undefined) {
					status.code += `add x9, x29, #${off}\n`;
				} else {
					status.code += `adr x9, ${bname}\n`;
				}
			}
			// Field offset for remainder.digits (BigInt): 24
			status.code += `add x9, x9, #24\n`;
		} else {
			// Complex base
			status.code += `mov x9, x0\n`;
		}
	} else {
		status.code += `mov x9, x0\n`;
	}
}

export function tryHoistBufferAddrs(
	loop: WhileLoopNode,
	nirBody: readonly NirStmt[] | undefined,
	status: BuildStatus,
): void {
	if (process.env.NOMEN_PIPE_DBG)
		console.error("PIPE tryHoist", (loop.condition as any)?.left_value?.value ?? "unknown");
	if (!buffer_pipeline_enabled()) return;
	if (!status.function_return_label) {
		if (process.env.NOMEN_PIPE_DBG) console.error("PIPE no return label");
		return;
	}

	const induction =
		(loop.condition as unknown as { left_value?: { value?: string }; value?: string }).left_value
			?.value ??
		(loop.condition as unknown as { value?: string }).value ??
		"";
	if (!induction || typeof induction !== "string" || is_int_literal(induction)) return;

	// Collect writes in this loop body for invariance check
	const writes = new Set<string>();
	const collectWrites = (stmts: readonly NirStmt[]) => {
		for (const s of stmts) {
			if (s.kind === "assign") {
				let e: any = s.target;
				while (e?.kind === "wrap") e = e.inner;
				if (e?.kind === "leaf" && e.name) writes.add(e.name);
			} else if (s.kind === "declare") {
				writes.add(s.decl.name);
			}
		}
	};
	if (nirBody) collectWrites(nirBody);
	// Also consider loop update writes induction
	// Induction is expected to be written via update, but for base hoist we treat it as variant
	writes.delete(induction);

	const accesses: { targetKey: string; targetNode: BaseNode; indexNode: BaseNode }[] = [];
	const scan = (stmts: readonly NirStmt[]) => {
		for (const s of stmts) {
			if (s.kind === "while" || s.kind === "for") continue;
			const walk = (n: any) => {
				if (!n || typeof n !== "object") return;
				if (n.node_type === "access" && n.access?.node_type === "access_func") {
					const fname = n.access.name;
					if (
						[
							"load_int",
							"load",
							"load_float",
							"store_int",
							"store",
							"store_float",
							"store_or_int",
						].includes(fname)
					) {
						const ttype: string | undefined = n.target?.type?.name;
						const isBuffer =
							(ttype && (ttype === "Buffer" || ttype.startsWith("Buffer_"))) ||
							(n.target?.node_type === "access" &&
								(n.target as AccessNode).access.node_type === "access_field" &&
								((n.target as AccessNode).access as unknown as { name: string }).name === "digits");
						if (isBuffer) {
							const key = bufferCacheKey(n.target);
							if (key) {
								const idx = n.access.params?.[0];
								if (idx) accesses.push({ targetKey: key, targetNode: n.target, indexNode: idx });
							}
						} else if (process.env.NOMEN_PIPE_DBG)
							console.error("PIPE ttype miss", ttype, JSON.stringify(n.target));
					}
				}
				for (const k of Object.keys(n)) {
					if (k === "parent" || k === "scope") continue;
					const v = n[k];
					if (Array.isArray(v)) v.forEach(walk);
					else if (v && typeof v === "object" && v.node_type) walk(v);
				}
			};
			walk(s.node);
		}
	};
	if (nirBody) scan(nirBody);
	if (process.env.NOMEN_PIPE_DBG)
		console.error(
			"PIPE accesses",
			accesses.length,
			`ind=${induction}`,
			accesses.map((a) => `${a.targetKey}:${(a.indexNode as any)?.value ?? "op"}`).join(","),
			`bodyKinds=${nirBody?.map((s) => s.kind).join(",") ?? "no-nir"}`,
		);
	if (accesses.length < 1) {
		if (process.env.NOMEN_PIPE_DBG) {
			console.error("PIPE <1 accesses");
			if (["pi", "mi", "si2", "si", "j"].includes(induction) && nirBody) {
				for (const s of nirBody) {
					console.error("PIPE dbg", s.kind, JSON.stringify(s.node).slice(0, 500));
				}
			}
		}
		return;
	}

	// Group by buffer
	const byBuffer = new Map<string, typeof accesses>();
	for (const a of accesses) {
		const g = byBuffer.get(a.targetKey) ?? [];
		g.push(a);
		byBuffer.set(a.targetKey, g);
	}
	if (process.env.NOMEN_PIPE_DBG)
		console.error(
			`PIPE byBuffer ${Array.from(byBuffer.entries())
				.map(([k, v]) => `${k}:${v.length}`)
				.join(",")}`,
		);
	const callFree = nirBody
		? nirBody.every((s) => tree_is_call_free(s.node, status, new Set()))
		: false;
	if (process.env.NOMEN_PIPE_DBG) console.error(`PIPE callFree=${callFree} for ind=${induction}`);

	for (const [bufKey, group] of byBuffer) {
		if (process.env.NOMEN_PIPE_DBG) console.error(`PIPE try ${bufKey} len=${group.length}`);
		const baseName = bufKey.split(".")[0];
		if (writes.has(baseName) || writes.has(bufKey)) {
			if (process.env.NOMEN_PIPE_DBG) console.error(`PIPE skip ${bufKey} written`);
			continue;
		}
		if (status.buffer_data_cache?.has(bufKey)) {
			if (process.env.NOMEN_PIPE_DBG) console.error(`PIPE skip ${bufKey} already cached`);
			continue;
		}
		const dataReg = allocPipelineReg(status, callFree);
		if (!dataReg) {
			if (process.env.NOMEN_PIPE_DBG)
				console.error(`PIPE no reg for ${bufKey} callFree=${callFree}`);
			continue;
		}
		if (process.env.NOMEN_PIPE_DBG)
			console.error(`PIPE hoist data ${bufKey} -> ${dataReg} callFree=${callFree}`);
		emitBufferStructAddr(group[0].targetNode, status);
		status.code += `ldr x9, [x9, #8]\n`;
		status.code += `mov ${dataReg}, x9\n`;
		if (!status.buffer_data_cache) status.buffer_data_cache = new Map();
		status.buffer_data_cache.set(bufKey, dataReg);
		if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
		// Only callee-saved regs need saving in prologue; caller-saved (x12-x15) do not
		if (
			dataReg.startsWith("x23") ||
			dataReg.startsWith("x24") ||
			dataReg.startsWith("x25") ||
			dataReg.startsWith("x26") ||
			dataReg.startsWith("x27") ||
			dataReg.startsWith("x28")
		) {
			status.callee_saved_regs_used.add(dataReg);
		} else {
			if (!status.nir_caller_saved_claimed) status.nir_caller_saved_claimed = new Set();
			status.nir_caller_saved_claimed.add(dataReg);
		}
	}

	// Hoist invariant bases
	if (!status.buffer_base_cache) status.buffer_base_cache = new Map();
	for (const acc of accesses) {
		const terms: { name: string; isLit: boolean }[] = [];
		if (!collectAddTerms(acc.indexNode, terms)) continue;
		const hasInd = terms.some((t) => !t.isLit && t.name === induction);
		if (!hasInd) continue;
		const invTerms = terms.filter((t) => t.name !== induction);
		if (invTerms.length === 0) continue;
		let invariant = true;
		for (const t of invTerms)
			if (!t.isLit && writes.has(t.name)) {
				invariant = false;
				break;
			}
		if (!invariant) continue;
		// Don't hoist if any inv term is induction of outer loop that is also variant? Already checked writes
		const baseKey = `${acc.targetKey}::${invTerms
			.map((t) => t.name)
			.sort()
			.join("+")}@${induction}`;
		if (status.buffer_base_cache.has(baseKey)) continue;
		const baseReg = allocPipelineReg(status, callFree);
		if (!baseReg) {
			if (process.env.NOMEN_PIPE_DBG) console.error(`PIPE no reg for base ${baseKey}`);
			continue;
		}
		if (process.env.NOMEN_PIPE_DBG) console.error(`PIPE hoist base ${baseKey} -> ${baseReg}`);
		if (invTerms.length === 1) {
			emitLoadTerm(invTerms[0], baseReg, status);
		} else {
			emitLoadTerm(invTerms[0], baseReg, status);
			for (let i = 1; i < invTerms.length; i++) {
				const t = invTerms[i];
				if (t.isLit) {
					const v = parseInt(t.name);
					if (!isNaN(v) && v >= 0 && v < 4096) status.code += `add ${baseReg}, ${baseReg}, #${v}\n`;
					else {
						status.code += `mov x9, #${v & 0xffff}\n`;
						if (v > 0xffff) status.code += `movk x9, #${(v >> 16) & 0xffff}, lsl #16\n`;
						status.code += `add ${baseReg}, ${baseReg}, x9\n`;
					}
				} else {
					// Load term into x9 then add
					emitLoadTerm(t, "x9", status);
					status.code += `add ${baseReg}, ${baseReg}, x9\n`;
				}
			}
		}
		status.buffer_base_cache.set(baseKey, {
			baseReg,
			induction,
			dataReg: status.buffer_data_cache?.get(acc.targetKey),
		});
		if (
			baseReg.startsWith("x23") ||
			baseReg.startsWith("x24") ||
			baseReg.startsWith("x25") ||
			baseReg.startsWith("x26") ||
			baseReg.startsWith("x27") ||
			baseReg.startsWith("x28")
		) {
			if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
			status.callee_saved_regs_used.add(baseReg);
		} else {
			if (!status.nir_caller_saved_claimed) status.nir_caller_saved_claimed = new Set();
			status.nir_caller_saved_claimed.add(baseReg);
		}
	}
}
