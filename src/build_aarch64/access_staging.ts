import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_float_type, is_scalar_type } from "../built_in_types.ts";
import { is_int_literal, parse_int_literal_bigint } from "../int_literal.ts";
import type AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type CastNode from "../nodes/CastNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { build_operand, int_tree_depth } from "./build_operation_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";

/**
 * Access staging bypass (ASM_PLAN_3 tranche L).
 *
 * The K survey named the remaining pidigits lever: the per-statement `x0`
 * staging model for Buffer-accessor index sums. Every inline
 * `buf.load_int(base + j + i)` pays three taxes per statement, all visible in
 * the Knuth-D loops:
 *
 * 1. The CHECKER hoists every non-value call argument into a `_param_N`
 *    const (check_function_call.ts), so each index sum is materialized into
 *    a frame slot (`str x0, [x29, #K]`) and read back at the access
 *    (`ldr x1, [x29, #K]` — the peephole deletes the load only when a
 *    register already happens to hold the value; the dead store survives).
 * 2. The sum itself is re-derived at EVERY access that mentions it —
 *    `wd_off + j + si2` is computed twice per D4-subtract iteration, with
 *    every add staged through `add x0, x1, x2; mov x1, x0`.
 * 3. The receiver's data pointer is re-derived at every access
 *    (`mov x9, x22; add x9, x9, #24; ldr x9, [x9, #8]`) — the existing
 *    `buffer_data_cache` dedups within a straight line only when a
 *    callee-saved register is free, and both the cache and the pool reset
 *    at every loop.
 *
 * This tranche bypasses the staging inside a verified straight-line window:
 *
 * - **Param forwarding**: qualifying `_param_N` hoisted temps are not
 *   emitted at all; their initializer tree is re-built AT the read (the
 *   window is empty — the hoisted declare is emitted immediately before its
 *   statement, so re-emitting at the arg site observes the same scalar
 *   values; calls cannot write scalar locals without `ref`, which the
 *   hoister excludes).
 * - **Chain building**: a pure `+` chain of names/literals is emitted
 *   dest-directed (`ldr dest, …; add dest, dest, x3`) — no x0 staging, no
 *   slot round-trip.
 * - **Pins**: the first access builds its index sum straight into a pin
 *   register (x10/x11 — never homes, never call-protocol) and the data
 *   pointer is copied to the other; later accesses in the window reuse them
 *   with zero re-derivation (`ldr x0, [x11, x10, lsl #3]`).
 *
 * Soundness is three independent fences, all conservative:
 *
 * 1. **Structural (per statement)**: the NIR dispatch notes each emitted
 *    statement — plain declares/assigns note their written names; fused
 *    cset/carry-fold spans (consumed > 1) note the names their plain
 *    assigns/declares write; EVERY other kind (eval, if, while, for,
 *    switch/match, return, async, fallback) taints the window. A pin dies
 *    when a name it reads is written after its fill. This is the fence
 *    against inlined `ref`-arg calls, which can write a scalar without any
 *    `bl` appearing in the text.
 * 2. **Textual (per consult)**: the emitted text between a pin's fill and
 *    the consult must contain no label, directive, branch, call or return,
 *    and must not DEFINE the pin register outside a memory operand. This
 *    kills pins at every join, loop back-edge, call site and prologue.
 * 3. **Register exclusivity**: pins come only from {x10, x11} minus every
 *    claimed register (promotions, both caches, param regs, ext-pool
 *    claims, at-address pins). Pinning is disabled wholesale under
 *    index-constant unrolling (`induction_const` non-empty): copies share
 *    an AST key while folding different constants (the tranche-C receipt
 *    class).
 */

let access_staging_on = true;

/** Kill-switch for A/B byte-identity tests (default: on). */
export function access_staging_enabled(): boolean {
	return access_staging_on;
}

export function set_access_staging_enabled(enabled: boolean): void {
	access_staging_on = enabled;
}

/** Inline Buffer accessors that may appear inside a kept window — they take
 * no ref args and cannot write a scalar local (the same set
 * build_operation_node's tree_is_call_free knows). */
const WINDOW_SAFE_ACCESSORS = new Set([
	"load_float",
	"store_float",
	"load_int",
	"store_int",
	"load",
	"store",
	"store_or_int",
]);

/** Operators a forwardable hoisted temp's tree may contain (no division:
 * its faulting semantics are not re-verified here). */
const FORWARDABLE_OPS = new Set(["+", "-", "*", "<<", ">>", "&", "|", "^"]);

const PIN_REGS = ["x10", "x11"];

interface PinEntry {
	key: string;
	reg: string;
	/** status.code length right after the fill — the window's start. */
	len: number;
	/** Names whose post-fill write kills this pin. */
	names: string[];
	/** Written-set snapshot at fill time. */
	snap: Set<string>;
}

function pin_state(status: BuildStatus) {
	return status.access_pins;
}

/** Drop every pin — the window is broken (control flow, call statement,
 * unknown emission). */
export function pins_taint(status: BuildStatus): void {
	status.access_pins = undefined;
}

function note_write(status: BuildStatus, name: string): void {
	if (status.access_pins) status.access_pins.written.add(name);
}

function fill_pin(status: BuildStatus, key: string, reg: string, names: string[]): void {
	if (!status.access_pins) {
		status.access_pins = { entries: new Map(), written: new Set() };
	}
	status.access_pins.entries.set(key, {
		key,
		reg,
		len: status.code.length,
		names,
		snap: new Set(status.access_pins.written),
	});
}

/** A pin register not claimed by any other subsystem. Pure — the claim
 * happens at fill time. */
export function alloc_pin_reg(status: BuildStatus): string | null {
	// Index-constant unrolling: copies fold different constants under the
	// same AST key — pinning is unsound there (the tranche-C receipt class).
	if (status.induction_const?.size) return null;
	// An int expression tree mid-build holds LIVE x10/x11 temps — an
	// accessor leaf (build_int_tree handles inline Buffer accessors) must
	// not fill a pin over them (ASM_PLAN_2 tranche F's pool contract).
	if (int_tree_depth > 0) return null;
	const taken = new Set<string>();
	for (const r of status.register_allocations?.values() ?? []) taken.add(r);
	for (const r of status.function_param_regs?.values() ?? []) taken.add(r);
	for (const r of status.callee_saved_regs_used ?? []) taken.add(r);
	for (const r of status.nir_caller_saved_claimed ?? []) taken.add(r);
	for (const r of status.buffer_data_cache?.values() ?? []) taken.add(r);
	for (const r of status.array_ptr_cache?.values() ?? []) taken.add(r);
	if (status.at_addr_reg) taken.add(status.at_addr_reg);
	for (const e of pin_state(status)?.entries.values() ?? []) taken.add(e.reg);
	for (const r of PIN_REGS) {
		if (!taken.has(r)) return r;
	}
	return null;
}

/**
 * Whether the emitted text between `from` and now keeps the pin register
 * live: no labels/directives (joins reset provenance), no branches/calls/
 * returns, and no instruction that DEFINES the register outside a memory
 * operand. Reads inside `[...]` address operands are the pin's own uses.
 */
function window_clean(status: BuildStatus, from: number, reg: string): boolean {
	const seg = status.code.slice(from);
	if (!seg) return true;
	for (const raw of seg.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith(".") || line.endsWith(":")) return false;
		if (/^(b|bl|blr|br|cbz|cbnz|tbz|tbnz|ret)\b/.test(line)) return false;
		const no_mem = line.replace(/\[[^\]]*\]/g, "");
		if (new RegExp(`\\b${reg}\\b`).test(no_mem)) return false;
	}
	return true;
}

function consult_pin(status: BuildStatus, key: string): PinEntry | null {
	const state = pin_state(status);
	const entry = state?.entries.get(key);
	if (!entry) return null;
	// Name-write fence: any name the pin reads written after its fill kills it.
	if (state) {
		for (const w of state.written) {
			if (!entry.snap.has(w) && entry.names.includes(w)) {
				state.entries.delete(key);
				return null;
			}
		}
	}
	if (!window_clean(status, entry.len, entry.reg)) {
		state?.entries.delete(key);
		return null;
	}
	return entry;
}

// ---------------------------------------------------------------------------
// Index chains: a pure `+` sum of identifier/int-literal leaves.
// ---------------------------------------------------------------------------

export interface IndexChain {
	key: string;
	names: string[];
	leaves: { node: ValueNode; name: string | null; imm: string | null }[];
}

function unwrap_grouped(node: BaseNode): BaseNode {
	let n = node;
	while (n && n.node_type === "grouped") {
		n = (n as unknown as { value?: BaseNode }).value as BaseNode;
	}
	return n;
}

/** A cast between same-size non-float scalars with no operator function is
 * a bitwise no-op on the aarch64 value path. */
export function unwrap_noop_int_cast(node: BaseNode): BaseNode {
	let n = unwrap_grouped(node);
	while (n.node_type === "cast") {
		const cast = n as CastNode;
		if (cast.operator_func) break;
		const to = cast.target_type?.name ?? "";
		const from = ((cast.value as unknown as { type?: { name?: string } } | undefined)?.type?.name ??
			"") as string;
		if (!from || !to) break;
		if (is_float_type(from) || is_float_type(to)) break;
		if (!is_scalar_type(from) || !is_scalar_type(to)) break;
		if (aarch64_size(from) !== aarch64_size(to)) break;
		n = unwrap_grouped(cast.value as BaseNode);
	}
	return n;
}

function chain_leaf(node: BaseNode): { name: string | null; imm: string | null } | null {
	if (node.node_type !== "value") return null;
	const raw = (node as ValueNode).value;
	if (typeof raw !== "string") return null;
	if (is_int_literal(raw)) {
		const parsed = parse_int_literal_bigint(raw);
		if (parsed === null) return null;
		return { name: null, imm: parsed.toString() };
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return null;
	if (raw === "true" || raw === "false" || raw.startsWith("_param_")) return null;
	return { name: raw, imm: null };
}

/** Canonical key + ordered leaves for a pure `+` chain over names and int
 * literals (grouped / no-op int casts unwrapped), or null. Chains must name
 * at least one identifier and stay small. */
export function collect_index_chain(node: BaseNode): IndexChain | null {
	const leaves: IndexChain["leaves"] = [];
	const visit = (n0: BaseNode): boolean => {
		const n = unwrap_noop_int_cast(n0);
		if (n.node_type === "op") {
			const op = n as OperationNode;
			if (op.op !== "+" || !op.left_value || !op.right_value) return false;
			return visit(op.left_value) && visit(op.right_value);
		}
		const leaf = chain_leaf(n);
		if (!leaf) return false;
		leaves.push({ node: n as ValueNode, name: leaf.name, imm: leaf.imm });
		return true;
	};
	if (!visit(node)) return null;
	if (leaves.length < 1 || leaves.length > 6) return null;
	if (!leaves.some((l) => l.name !== null)) return null;
	const names = leaves
		.filter((l) => l.name)
		.map((l) => l.name!)
		.sort();
	const imms = leaves
		.filter((l) => l.imm)
		.map((l) => l.imm!)
		.sort();
	return { key: `idx:${names.join("+")}|${imms.join("+")}`, names, leaves };
}

/** Emit the chain dest-directed: first leaf into `dest`, each further leaf
 * staged through x3 (free scratch at accessor time) and folded with `add`.
 * Literals within the add-immediate range fold directly. */
export function build_index_chain(chain: IndexChain, dest: string, status: BuildStatus): void {
	let first = true;
	for (const leaf of chain.leaves) {
		if (first) {
			build_operand(leaf.node, dest, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			first = false;
			continue;
		}
		if (leaf.imm !== null && BigInt(leaf.imm) >= 0n && BigInt(leaf.imm) <= 4095n) {
			status.code += `add ${dest}, ${dest}, #${leaf.imm}\n`;
		} else {
			build_operand(leaf.node, "x3", status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `add ${dest}, ${dest}, x3\n`;
		}
	}
}

// ---------------------------------------------------------------------------
// Hoisted-param forwarding.
// ---------------------------------------------------------------------------

/** The initializer tree a `_param_N` spliced argument should be re-emitted
 * from at its read, or null when the temp must keep its slot. */
export function forwarded_param_tree(param: BaseNode, status: BuildStatus): BaseNode | null {
	if (param.node_type !== "value") return null;
	const name = (param as ValueNode).value;
	if (typeof name !== "string" || !/^_param_\d+$/.test(name)) return null;
	return status.forwarded_param_inits?.get(name) ?? null;
}

function count_name_reads(root: BaseNode, name: string, seen: Set<unknown>): number {
	if (!root || typeof root !== "object" || seen.has(root)) return 0;
	seen.add(root);
	let count = 0;
	if (root.node_type === "value" && (root as ValueNode).value === name) count += 1;
	const n = root as unknown as Record<string, unknown>;
	for (const key of Object.keys(n)) {
		if (key === "parent" || key === "scope") continue;
		const v = n[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "node_type" in (item as object)) {
					count += count_name_reads(item as BaseNode, name, seen);
				}
			}
		} else if (v && typeof v === "object" && "node_type" in (v as object)) {
			count += count_name_reads(v as BaseNode, name, seen);
		}
	}
	return count;
}

function forwardable_tree(node: BaseNode): boolean {
	const n = node;
	if (n.node_type === "grouped") {
		return forwardable_tree((n as unknown as { value: BaseNode }).value);
	}
	if (n.node_type === "cast") {
		const cast = n as CastNode;
		if (cast.operator_func) return false;
		return forwardable_tree(cast.value as BaseNode);
	}
	if (n.node_type === "op") {
		const op = n as OperationNode;
		if (!FORWARDABLE_OPS.has(op.op) || !op.left_value || !op.right_value) return false;
		return forwardable_tree(op.left_value) && forwardable_tree(op.right_value);
	}
	if (n.node_type === "value") {
		const raw = (n as ValueNode).value;
		if (typeof raw !== "string") return false;
		if (is_int_literal(raw)) return true;
		return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && raw !== "true" && raw !== "false";
	}
	return false;
}

/** Whether the single read of `name` in the statement is a DIRECT argument
 * of an inline Buffer accessor (the only read sites that consult the
 * forwarding map) — a temp read by any other call/expr keeps its slot. */
function read_is_buffer_accessor_arg(statement: BaseNode, name: string): boolean {
	let direct = false;
	const walk = (node: BaseNode | undefined, seen: Set<unknown>): void => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if (
			node.node_type === "access" &&
			(node as unknown as { access?: { node_type?: string; name?: string } }).access?.node_type ===
				"access_func"
		) {
			const acc = (
				node as unknown as {
					access?: { node_type?: string; name?: string; params?: BaseNode[] };
					target?: BaseNode;
				}
			).access!;
			if (WINDOW_SAFE_ACCESSORS.has(acc.name ?? "")) {
				walk((node as unknown as { target?: BaseNode }).target, seen);
				for (const p of acc.params ?? []) {
					if (p.node_type === "value" && (p as ValueNode).value === name) {
						direct = true;
					} else {
						walk(p, seen);
					}
				}
				return;
			}
		}
		const n = node as unknown as Record<string, unknown>;
		for (const key of Object.keys(n)) {
			if (key === "parent" || key === "scope") continue;
			const v = n[key];
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === "object" && "node_type" in (item as object)) {
						walk(item as BaseNode, seen);
					}
				}
			} else if (v && typeof v === "object" && "node_type" in (v as object)) {
				walk(v as BaseNode, seen);
			}
		}
	};
	walk(statement, new Set());
	return direct;
}

/** Whether a hoisted allocation declare may skip its slot and be re-emitted
 *  at its single read: a `_param_N` const with a scalar non-float type and a
 *  pure arithmetic tree, read exactly once in the owning statement — at a
 *  direct inline-Buffer-accessor argument. (Flag-agnostic core — the value
 *  numbering pass reuses these gates for its own rewritten inits.) */
export function hoistable_hoisted_param(alloc: BaseNode, statement: BaseNode): BaseNode | null {
	if (alloc.node_type !== "declare") return null;
	const decl = alloc as DeclarationNode;
	if (typeof decl.name !== "string" || !/^_param_\d+$/.test(decl.name)) return null;
	if (decl.declaration !== "const" || !decl.value) return null;
	if (decl.is_heap_array_literal || decl.is_heap_array_copy) return null;
	const type_name = decl.type?.name ?? "";
	if (!type_name || is_float_type(type_name) || !is_scalar_type(type_name)) return null;
	if (!forwardable_tree(decl.value)) return null;
	// The temp is read exactly once — at its spliced argument site.
	if (count_name_reads(statement, decl.name, new Set()) !== 1) return null;
	// ... and that site is one the accessor paths actually forward at.
	if (!read_is_buffer_accessor_arg(statement, decl.name)) return null;
	return decl.value;
}

/** Whether a hoisted allocation declare may skip its slot and be re-emitted
 *  at its single read (the staging-enabled gate on top of the shared
 *  shape gates). */
export function forwardable_hoisted_param(alloc: BaseNode, statement: BaseNode): BaseNode | null {
	if (!access_staging_enabled()) return null;
	return hoistable_hoisted_param(alloc, statement);
}

// ---------------------------------------------------------------------------
// Statement-window notes (called from emit_nir's dispatch wrapper).
// ---------------------------------------------------------------------------

/** Whether the AST contains any call shape that could write a scalar local
 * without a `bl` in the text: flat calls, spawns, and every method access
 * except the inline Buffer accessors (those take no ref args). */
function window_safe_tree(node: BaseNode, seen: Set<unknown>): boolean {
	if (!node || typeof node !== "object" || seen.has(node)) return true;
	seen.add(node);
	const n = node as unknown as Record<string, unknown>;
	if (n.node_type === "func_call" || n.node_type === "spawn") return false;
	if (n.node_type === "access") {
		const acc = (n as { access?: { node_type?: string; name?: string } }).access;
		if (acc && acc.node_type === "access_func") {
			if (!WINDOW_SAFE_ACCESSORS.has(acc.name ?? "")) return false;
		}
	}
	for (const key of Object.keys(n)) {
		if (key === "parent" || key === "scope") continue;
		const v = n[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "node_type" in (item as object)) {
					if (!window_safe_tree(item as BaseNode, seen)) return false;
				}
			}
		} else if (v && typeof v === "object" && "node_type" in (v as object)) {
			if (!window_safe_tree(v as BaseNode, seen)) return false;
		}
	}
	return true;
}

/**
 * Post-emission note for one dispatched statement span (ASM_PLAN_3 tranche
 * L): plain declares/assigns keep the pin window and record their written
 * names; a consumed cset/carry-fold span (consumed > 1 off a declare) is
 * pure flag materialization — record every name the span's declares and
 * plain assigns write; everything else taints.
 */
export function note_dispatched_statement(
	kind: string,
	span: BaseNode[],
	status: BuildStatus,
): void {
	if (!access_staging_on) return;
	if (kind === "declare" && span.length > 1) {
		// Fused cset / carry-fold: cmp/cset (+ plain assign) — no branches.
		for (const stmt of span) {
			if (stmt.node_type === "declare") {
				note_write(status, (stmt as DeclarationNode).name);
			} else if (stmt.node_type === "assign") {
				const target = (stmt as AssignmentNode).left_value;
				if (target?.node_type === "value" && typeof (target as ValueNode).value === "string") {
					note_write(status, (target as ValueNode).value as string);
				} else {
					pins_taint(status);
					return;
				}
			}
			// The consumed ifs write only their single flag assign (noted
			// above via the span walk — their body statement IS the assign
			// listed in the span only when the fuse consumed it; the flag
			// write is covered by the fuse's own gates).
		}
		// The flag name itself: the fused if's branch assign target. The
		// fuse gates guarantee it is a plain name assign inside the if —
		// recover it from the consumed if bodies.
		for (const stmt of span) {
			if (stmt.node_type !== "if") continue;
			const ifn = stmt as unknown as {
				if_branch?: { statements?: BaseNode[] };
			};
			for (const inner of ifn.if_branch?.statements ?? []) {
				if (inner.node_type === "assign") {
					const target = (inner as AssignmentNode).left_value;
					if (target?.node_type === "value" && typeof (target as ValueNode).value === "string") {
						note_write(status, (target as ValueNode).value as string);
					}
				}
			}
		}
		return;
	}
	if (kind === "declare") {
		const decl = span[0] as DeclarationNode;
		note_write(status, decl.name);
		if (decl.value && !window_safe_tree(decl.value, new Set())) pins_taint(status);
		return;
	}
	if (kind === "assign") {
		const assign = span[0] as AssignmentNode;
		const target = assign.left_value;
		if (
			target?.node_type === "value" &&
			typeof (target as ValueNode).value === "string" &&
			window_safe_tree(assign.right_value ?? target, new Set())
		) {
			note_write(status, (target as ValueNode).value as string);
			return;
		}
		pins_taint(status);
		return;
	}
	pins_taint(status);
}

// ---------------------------------------------------------------------------
// Accessor consult/fill entry points.
// ---------------------------------------------------------------------------

/**
 * Resolve the index for an inline Buffer access. Returns the register
 * holding the index (x1 or a pin) — building it when necessary. `param` is
 * the (possibly `_param_N`-spliced) index argument.
 */
export function staged_index_reg(param: BaseNode, status: BuildStatus): string {
	// The value-numbering pass (tranche M) may have rewritten this hoisted
	// temp's initializer (its invariant prefix lives in a preheader _vn_N
	// now) — the consult is deliberately ABOVE the staging flag check: with
	// staging off the rewritten tree still builds, straight into x1.
	const forwarded = forwarded_param_tree(param, status);
	const effective = forwarded ?? param;
	if (!access_staging_on) {
		build_operand(effective, "x1", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		return "x1";
	}
	const chain = collect_index_chain(effective);
	if (!chain) {
		build_operand(effective, "x1", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		return "x1";
	}
	const live = consult_pin(status, chain.key);
	if (live) return live.reg;
	const pin_reg = alloc_pin_reg(status);
	const dest = pin_reg ?? "x1";
	build_index_chain(chain, dest, status);
	if (pin_reg) fill_pin(status, chain.key, pin_reg, chain.names);
	return dest;
}

/**
 * Resolve the data pointer for an inline Buffer access: a live pin, the
 * existing cache, or a fresh derivation (pinned when a register is free).
 * `derive` emits the uncached derivation and returns its register.
 */
export function staged_data_reg(
	receiver: BaseNode,
	buf_key: string | null,
	status: BuildStatus,
	derive: () => string,
): string {
	if (!access_staging_on || !buf_key) return derive();
	const names = buf_key.split(".");
	const key = `data:${buf_key}`;
	const live = consult_pin(status, key);
	if (live) return live.reg;
	const reg = derive();
	if (reg !== "x9") return reg;
	const pin = alloc_pin_reg(status);
	if (!pin) return reg;
	status.code += `mov ${pin}, x9\n`;
	fill_pin(status, key, pin, names);
	return pin;
}
