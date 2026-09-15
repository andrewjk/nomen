import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type ParameterNode from "../../nodes/ParameterNode.ts";
import type Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Interprocedural no-mutation scan for borrow-position `to_string()` elision
 * (STRING_PLAN tranche 3).
 *
 * `s.to_string()` on an owned string strdups the receiver's bytes; when the
 * result is consumed at a BORROW position (a call argument whose parameter is
 * a plain `string`), the copy exists only so the callee can't touch the
 * caller's bytes. When the callee provably cannot mutate (or free / take
 * ownership of) the bytes reached through that parameter, the copy is dead
 * weight: pass the receiver's pair straight through and skip the strdup and
 * the temporary free.
 *
 * Plain `string` params share their bytes with the caller, and `String.set`
 * takes `ref self`, writing through them (`strb w2, [x19, x1]`). So the
 * elision is sound ONLY when the callee — transitively through its own
 * plain-string-param calls — has no byte-mutation reach on the parameter:
 *   - dispatching a `ref self` method (`set`) on the parameter,
 *   - passing the parameter to a `ref string` param (mutable borrow),
 *   - passing it to a `move string` param (the callee would own — and free —
 *     the caller's bytes),
 *   - swapping the parameter, spawning/async-capturing it (conservative),
 *   - anything a raw `#arch` body might do that the AST can't show
 *     (conservative textual rules below).
 *
 * The scan is deliberately one reviewed unit; the elision consumers
 * (check_function_call) must not grow their own reachability logic.
 */

let elision_enabled = true;

/** Kill-switch (default ON). OFF = no argument is ever marked, so emission
 *  stays byte-identical to the pre-tranche output. */
export function borrow_to_string_elision_enabled(): boolean {
	return elision_enabled;
}

export function set_borrow_to_string_elision_enabled(enabled: boolean): void {
	elision_enabled = enabled;
}

/** Per-(function, param index) memo. FunctionNode identities are stable for
 *  the whole compile; a WeakMap lets reused ASTs across builds drop caches. */
const mutation_cache = new WeakMap<FunctionNode, Map<number, boolean>>();

/** Is this parameter annotation a plain (borrow-by-value) `string`? */
function is_plain_string_param(p: ParameterNode | undefined): boolean {
	if (!p || p.is_self_param || p.is_variadic) return false;
	const t = p.type;
	return !!t && t.name === "string" && !t.is_view && !t.is_ref && !t.is_array && !p.is_moved;
}

/** Is `t` an owned (non-view, non-array) `string` type? */
function is_owned_string_type(t: Type | undefined): boolean {
	return !!t && t.name === "string" && !t.is_view && !t.is_array;
}

/**
 * Decides (and stamps) the borrow-position elision for one call argument.
 * Called from check_function_call's argument loop with the ALREADY-CHECKED
 * argument node, the callee's parameter for this position, and the arg index.
 * Returns true when the argument was marked (`borrow_to_string` on its
 * access_func) and the caller must skip the usual temporary hoist.
 */
export function maybe_mark_borrow_to_string_arg(
	param: BaseNode,
	func_param: ParameterNode | undefined,
	func: FunctionNode,
	arg_index: number,
	node: { move_param_indices?: number[]; swap_params?: Map<number, BaseNode> },
	status: CheckStatus,
): boolean {
	if (!borrow_to_string_elision_enabled()) return false;
	if (!func_param || !is_plain_string_param(func_param)) return false;
	if (!is_plain_string_receiver_to_string(param, status)) return false;
	// Explicit `move`/swap at this argument position transfers ownership —
	// never a borrow.
	if (node.move_param_indices?.includes(arg_index)) return false;
	if (node.swap_params?.has(arg_index)) return false;
	// The soundness gate: the callee must have no mutation reach on this
	// parameter. `arg_index` is the caller-side index; the scan maps it to
	// the callee's body index (self offset) internally.
	if (string_param_may_mutate(func, arg_index, status)) return false;
	const access_func = (param as AccessNode).access as AccessFunctionCallNode;
	access_func.borrow_to_string = true;
	return true;
}

/**
 * Marks `X.to_string()` when it appears as a string CONCAT operand (`a + b`
 * on strings). Concat is a read-only consumer by construction (it copies both
 * operands into a fresh buffer), so no mutation scan is needed. Called from
 * check_operation_node after both operands have been checked.
 */
export function maybe_mark_borrow_to_string_operand(side: BaseNode, status: CheckStatus): boolean {
	if (!borrow_to_string_elision_enabled()) return false;
	if (!is_plain_string_receiver_to_string(side, status)) return false;
	((side as AccessNode).access as AccessFunctionCallNode).borrow_to_string = true;
	return true;
}

/**
 * Shape test for the elision itself: an `X.to_string()` AccessNode where X is
 * an owned string reached through a name or field chain (never a call/concat
 * temp — an elided borrow of a temporary would leak it). The RECEIVER type
 * matters, not the result type: `n.to_string()` on an int produces a FRESH
 * allocation (int_to_string) — a borrow of `n` would be garbage.
 */
function is_plain_string_receiver_to_string(node: BaseNode, status: CheckStatus): boolean {
	if (node.node_type !== "access") return false;
	const access = node as AccessNode;
	if (access.access.node_type !== "access_func") return false;
	const access_func = access.access as AccessFunctionCallNode;
	if (access_func.name !== "to_string" || access_func.params.length !== 0) return false;
	const receiver_type = type_from_value_node_safe(access.target, status);
	if (!is_owned_string_type(receiver_type)) return false;
	return is_name_or_field_chain(access.target);
}

function is_name_or_field_chain(node: BaseNode): boolean {
	if (node.node_type === "value") {
		// A bare name: local, param, self — or a string literal (static data,
		// never freed; borrowing it skips a strdup of static bytes).
		return true;
	}
	if (node.node_type !== "access") return false;
	const access = node as AccessNode;
	return access.access.node_type === "access_field" && is_name_or_field_chain(access.target);
}

/**
 * Whether the callee can mutate (or free / take ownership of) the bytes
 * reached through its plain-`string` parameter at caller arg index
 * `arg_index`. Cached per (function, index).
 */
export function string_param_may_mutate(
	func: FunctionNode,
	arg_index: number,
	status: CheckStatus,
): boolean {
	const self_offset = func.params[0]?.is_self_param ? 1 : 0;
	return string_param_may_mutate_body(func, arg_index + self_offset, status, new Set());
}

function string_param_may_mutate_body(
	func: FunctionNode,
	body_index: number,
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	let memo = mutation_cache.get(func);
	if (!memo) {
		memo = new Map();
		mutation_cache.set(func, memo);
	}
	const cached = memo.get(body_index);
	if (cached !== undefined) return cached;

	// Seed the memo BEFORE scanning so a recursive plain-string-param call
	// through this same (function, index) edge terminates as "no mutation
	// along this path". The recursion still explores every OTHER path, so a
	// real mutation reach is never masked.
	memo.set(body_index, false);

	const param = func.params[body_index];
	const result = param ? scan_param_reaches(func, param.name, status, visiting) : true;
	memo.set(body_index, result);
	return result;
}

/** Walks `func`'s body looking for a mutation reach on the local name
 *  `pname` (a plain string param of `func`). */
function scan_param_reaches(
	func: FunctionNode,
	pname: string,
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	// Raw `#arch` bodies are opaque to the AST walk: apply the conservative
	// textual rules. A function may mix raw and Nomen statements — every raw
	// block must come back clean for a "no reach" verdict.
	for (const stmt of func.statements) {
		for (const raw of collect_raw_nodes(stmt)) {
			if (raw_block_may_mutate(raw.value, pname)) return true;
		}
	}
	for (const stmt of func.statements) {
		if (walk_mutation(stmt, pname, status, visiting)) return true;
	}
	return false;
}

function collect_raw_nodes(node: BaseNode): { value: string }[] {
	if (node.node_type === "raw") return [node as unknown as { value: string }];
	const out: { value: string }[] = [];
	for (const child of child_nodes(node)) {
		out.push(...collect_raw_nodes(child));
	}
	return out;
}

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

function walk_mutation(
	node: BaseNode,
	pname: string,
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_func") {
			const access_func = access.access as AccessFunctionCallNode;
			// Direct dispatch of a `ref self` method on the parameter itself:
			// `p.set(i, c)` writes through the caller's bytes.
			if (
				access.target.node_type === "value" &&
				(access.target as ValueNode).value === pname &&
				method_self_is_ref(access_func, status)
			) {
				return true;
			}
			if (
				call_site_mutates(
					access_func as unknown as CallSite,
					access.target,
					pname,
					status,
					visiting,
				)
			) {
				return true;
			}
			// Nested calls inside the receiver chain or the arguments still
			// need their own reach checks.
			if (walk_mutation(access.target, pname, status, visiting)) return true;
			for (const arg of access_func.params) {
				if (walk_mutation(arg, pname, status, visiting)) return true;
			}
			return false;
		}
	}
	if (node.node_type === "func_call") {
		if (call_site_mutates(node as unknown as CallSite, null, pname, status, visiting)) {
			return true;
		}
	}
	if (node.node_type === "spawn" || node.node_type === "async_block") {
		// Concurrency escapes are opaque to the scan: if the parameter is
		// mentioned anywhere in the subtree, assume a mutation reach.
		return mentions(JSON.stringify(node), pname);
	}
	// A whole-parameter rebind (`p = ...`) is NOT a mutation reach: value
	// semantics strdup into the callee's own slot; the caller's bytes are
	// untouched. Assignments contribute only through their RHS expression,
	// which the generic walk below covers.
	for (const child of child_nodes(node)) {
		if (walk_mutation(child, pname, status, visiting)) return true;
	}
	return false;
}

interface CallSite {
	name: string;
	params: BaseNode[];
	mangled_name?: string;
	move_param_indices?: number[];
	swap_params?: Map<number, BaseNode>;
	resolved_function?: FunctionNode;
}

function call_site_mutates(
	call: CallSite,
	receiver: BaseNode | null,
	pname: string,
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	for (let j = 0; j < call.params.length; j++) {
		const arg = call.params[j];
		if (!(arg.node_type === "value" && (arg as ValueNode).value === pname)) continue;
		// Explicit `move p` / swap involvement: ownership transfer or
		// exchange — the callee (or the swap partner's cleanup) frees.
		if (call.move_param_indices?.includes(j)) return true;
		if (call.swap_params?.has(j)) return true;
		// Interpolation helpers are compiler-synthesized renderers:
		// read-only by construction (and resolvable through no table).
		if (call.name.startsWith("_string_interpolate_")) continue;
		const callee = resolve_callee(call, receiver, status);
		if (!callee) return true; // unresolvable — conservative
		const off = callee.params[0]?.is_self_param ? 1 : 0;
		const callee_param = callee.params[j + off];
		if (!callee_param) return true; // variadic/forwarded shape — conservative
		if (callee_param.type.is_ref) return true; // mutable borrow
		if (callee_param.is_moved) return true; // callee would own (and free)
		if (callee_param.type.is_view) continue; // views are read-only
		if (
			callee_param.type.name === "string" &&
			!callee_param.type.is_array &&
			!callee_param.is_variadic
		) {
			// Plain string param: recurse into the callee (cycle-safe).
			const key = `${callee.label_name ?? callee.name}#${j + off}`;
			if (visiting.has(key)) continue;
			visiting.add(key);
			const reaches = string_param_may_mutate_body(callee, j + off, status, visiting);
			visiting.delete(key);
			if (reaches) return true;
		}
		// Non-string positions can't reach the string's bytes.
	}
	return false;
}

/** Resolves a call site to its FunctionNode. Free calls resolve through the
 *  gathered function table (available before bodies are checked); method
 *  calls resolve through the receiver's struct. */
function resolve_callee(
	call: CallSite,
	receiver: BaseNode | null,
	status: CheckStatus,
): FunctionNode | undefined {
	if (call.resolved_function) return call.resolved_function;
	if (receiver) {
		const recv_type = type_from_value_node_safe(receiver, status);
		if (recv_type?.name) {
			const struct = status.structs.find((s) => s.name === recv_type.name);
			const method = struct?.functions.findLast((f) => f.name === call.name);
			if (method) return method;
		}
		return undefined; // method call with unresolved receiver — conservative
	}
	return status.functions.findLast((f) => f.name === call.name);
}

function type_from_value_node_safe(node: BaseNode, status: CheckStatus): Type | undefined {
	try {
		return type_from_value_node(node, status);
	} catch {
		return undefined;
	}
}

/** Whether the method this access_func names takes `ref self` on the string
 *  struct — the only byte-mutating dispatch shape for a string receiver. */
function method_self_is_ref(access_func: AccessFunctionCallNode, status: CheckStatus): boolean {
	const string_struct = status.structs.find((s) => s.name === "string");
	if (!string_struct) return true; // can't verify — conservative
	const method = string_struct.functions.find((f) => f.name === access_func.name);
	if (!method) return true; // unknown method — conservative
	return !!method.params.filter((p) => p.is_self_param).some((p) => p.is_ref || p.type?.is_ref);
}

// ---------------------------------------------------------------------------
// Generic child traversal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Raw-block textual rules
// ---------------------------------------------------------------------------

/**
 * Conservative textual reach test for one raw block. The block must come back
 * clean for EVERY target text the backends may emit: a block whose arch list
 * covers both backends must pass both rules.
 *
 * - aarch64 asm: a byte/word STORE (or RMW/atomic) is the only way to write
 *   memory, and `bl` into a free/mutator can corrupt the caller's bytes. Any
 *   store mnemonic or mutating call target ⇒ reach. (Register spills store
 *   the POINTER, not through it — still conservatively a reach.)
 * - C: the raw body receives the param as a fat `nomen_string` value; writes
 *   go through the `.ptr` half (or `->ptr` for a `ref string`). Any use of
 *   the pointer half (index/deref — reads and writes are indistinguishable at
 *   this granularity) or the byte-writing libc surface ⇒ reach.
 */
function raw_block_may_mutate(content: string, pname: string): boolean {
	for (const block of split_raw_blocks(content)) {
		if (block.arches === undefined || block.arches.includes("aarch64")) {
			if (asm_block_may_mutate(block.code)) return true;
		}
		if (
			block.arches === undefined ||
			block.arches.some((a) => a === "c" || a === "aarch64_use_c")
		) {
			if (c_block_may_mutate(block.code, pname)) return true;
		}
	}
	return false;
}

interface RawBlock {
	arches: string[] | undefined;
	code: string;
}

function split_raw_blocks(content: string): RawBlock[] {
	const blocks: RawBlock[] = [];
	const lines = content.split("\n");
	let arches: string[] | undefined;
	let current: string[] = [];
	const flush = () => {
		if (current.length) blocks.push({ arches, code: current.join("\n") });
		current = [];
	};
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#arch:")) {
			flush();
			arches = trimmed
				.substring(6)
				.split(",")
				.map((a) => a.trim())
				.filter((a) => a.length > 0);
			continue;
		}
		if (trimmed.startsWith("#platform:") || trimmed.startsWith("#scope:")) continue;
		current.push(line);
	}
	flush();
	return blocks;
}

const ASM_STORE_RE =
	/^\s*(?:st[a-z0-9]*|cas[a-z0-9]*|swp[a-z0-9]*|ld[a-z]*(?:add|set|clr|eor|max|min|umax|umin)[a-z0-9]*)\b/;
const ASM_MUTATOR_BL_RE = /(?:free|_set\b|_set_|memcpy|strcat|strcpy|sprintf|memmove)/;

function asm_block_may_mutate(code: string): boolean {
	for (const line of code.split("\n")) {
		if (ASM_STORE_RE.test(line)) return true;
		const bl = line.match(/^\s*bl\s+(\S+)/);
		if (bl && ASM_MUTATOR_BL_RE.test(bl[1])) return true;
	}
	return false;
}

function c_block_may_mutate(code: string, pname: string): boolean {
	const name = escape_regex(pname);
	// The pointer expressions a body can write through: the param's `.ptr`
	// half (fat by-value param), `->ptr` (fat `ref string` param), or the
	// bare name (pointer-typed interop shapes).
	const ptr = `${name}(?:\\s*\\.\\s*ptr|\\s*->\\s*ptr)?`;
	// Indexing the pointer (`p.ptr[i] = c` — and reads, which are
	// indistinguishable at this granularity — conservative).
	if (new RegExp(`${ptr}\\s*\\[`).test(code)) return true;
	// Dereferencing it: `*p.ptr = c`, `(*p.ptr)[i]`, `*(p.ptr + i)`.
	if (new RegExp(`\\*\\s*${ptr}\\b`).test(code)) return true;
	if (new RegExp(`\\(\\s*\\*\\s*${ptr}\\b`).test(code)) return true;
	// ANY call taking the pointer as its FIRST argument — C convention makes
	// first pointer args destinations (`strcpy(p.ptr, …)`,
	// `sprintf(p.ptr, …)`), and an arbitrary helper `mutate(p.ptr)` is
	// unverifiable. Readers like `printf("%s", p.ptr)` pass the pointer in a
	// LATER position and stay clean.
	if (new RegExp(`\\b\\w+\\s*\\(\\s*(?:\\*\\s*)?${ptr}\\b`).test(code)) return true;
	// The byte-writing / allocation libc surface anywhere at all.
	if (
		/\b(?:strcpy|strcat|sprintf|snprintf|memcpy|memmove|free|realloc|String_set)\s*\(/.test(code)
	) {
		return true;
	}
	return false;
}

function mentions(text: string, pname: string): boolean {
	return new RegExp(`\\b${escape_regex(pname)}\\b`).test(text);
}

function escape_regex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
