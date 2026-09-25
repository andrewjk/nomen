import type BuildStatus from "../build_c/BuildStatus.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import StructNode from "../nodes/StructNode.ts";
import { direct_string_fields } from "./has_string_fields.ts";

/**
 * Pre-build classification of which functions return value structs whose
 * string fields are UNIFORMLY heap-owned via return-boundary normalization.
 * Populates `status.normalized_struct_returners`; a caller binding a call
 * result of a registered function records the struct's string fields and
 * frees them at scope exit, while bindings of unregistered callees keep the
 * pre-existing borrow behavior (never recorded, never freed — sound, though
 * it may leak on slot overwrites, which is the documented status quo).
 *
 * The rule is deliberately narrow: a function normalizes iff EVERY
 * struct-return statement returns a BARE VARIABLE (a local or parameter).
 * That is the transfer shape — the returned variable dies at the return, so
 * the boundary normalization (transfer recorded heap fields, strdup the
 * rest) is sound and leak-free. Every other shape keeps the status quo:
 *
 *   - container borrow accessors (`at`/`first`/`slice`/`load` — e.g.
 *     `Map.get`'s `return self.values.load_T(idx)`) yield SLOT-owned bytes;
 *     normalizing them would leak in expression-temp consumers
 *     (`m.get(k).field`) that nobody records or frees;
 *   - owned accessors (`pop`/`move_T`/`copy`) transfer slot-owned heap
 *     buffers — the caller's recording is sound WITHOUT normalization, so
 *     they record via the owned-accessor rule (see
 *     call_init_string_fields.ts) and the callee skips the copy;
 *   - forwarded calls (`return make()`) are skipped when the callee is
 *     registered (its result is already uniformly owned — copying it would
 *     leak the inner buffers) and keep the status quo when it is not.
 *
 * This runs as a WHOLE-PROGRAM AST PRE-PASS (before any function body is
 * built) because a build-order-sensitive registry cannot work: nested
 * functions are built after their enclosing function's body, so a runtime
 * registration would be invisible to the caller's earlier lookup.
 */

/** Collect every function and struct declaration under the AST (including
 *  nested functions, struct methods, and function bodies at any depth). */
function collect(node: BaseNode, fns: FunctionNode[], structs: StructNode[], seen: Set<BaseNode>) {
	if (!node || typeof node !== "object" || seen.has(node)) return;
	seen.add(node);
	if ((node as FunctionNode).node_type === "func") fns.push(node as FunctionNode);
	if ((node as StructNode).node_type === "struct") structs.push(node as StructNode);
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope") continue;
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object" && "node_type" in item) {
					collect(item as BaseNode, fns, structs, seen);
				}
			}
		} else if (value && typeof value === "object" && "node_type" in value) {
			collect(value as BaseNode, fns, structs, seen);
		}
	}
}

/** The DIRECT `return <expr>` statements of a function body (nested function
 *  declarations are not descended into — their returns belong to them). */
function direct_returns(fn: FunctionNode): ReturnNode[] {
	const out: ReturnNode[] = [];
	const seen = new Set<BaseNode>();
	const walk = (node: BaseNode) => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if ((node as FunctionNode).node_type === "func" && node !== (fn as unknown as BaseNode)) {
			return;
		}
		if (node.node_type === "return") out.push(node as ReturnNode);
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const value = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item && typeof item === "object" && "node_type" in item) {
						walk(item as BaseNode);
					}
				}
			} else if (value && typeof value === "object" && "node_type" in value) {
				walk(value as BaseNode);
			}
		}
	};
	for (const statement of fn.statements ?? []) walk(statement);
	return out;
}

/**
 * Populate `status.normalized_struct_returners` from the whole program AST.
 */
export function gather_normalized_struct_returners(root: BaseNode, status: BuildStatus): void {
	const fns: FunctionNode[] = [];
	const structs: StructNode[] = [];
	collect(root, fns, structs, new Set());

	// The functions whose STRUCT return type carries string fields — only
	// their classification matters (callers of other functions have no
	// string fields to record).
	const candidates: FunctionNode[] = [];
	for (const fn of fns) {
		const ret = fn.return_type;
		if (!ret || ret.is_array || ret.is_view) continue;
		const struct = structs.find((s) => s.name === ret.name && !s.is_simple_type && !s.is_class);
		if (!struct) continue;
		if (!direct_string_fields(struct).length) continue;
		candidates.push(fn);
	}
	if (!candidates.length) return;

	// Fixpoint: a candidate is normalizing iff EVERY struct-return returns a
	// bare variable, OR a call to another normalizing candidate (a forwarded
	// uniformly-owned value). Start optimistic, drop violators, repeat.
	const normalizing = new Set<string>(candidates.map((c) => c.name));
	let changed = true;
	while (changed) {
		changed = false;
		for (const fn of candidates) {
			if (!normalizing.has(fn.name)) continue;
			for (const ret of direct_returns(fn)) {
				const value = ret.value ?? undefined;
				// Bare variable (local/parameter) — the transfer shape.
				if (value && value.node_type === "value") continue;
				// Forwarded call to another normalizing candidate.
				if (
					value &&
					value.node_type === "func_call" &&
					normalizing.has((value as { name?: string }).name ?? "")
				) {
					continue;
				}
				normalizing.delete(fn.name);
				changed = true;
				break;
			}
		}
	}
	if (!status.normalized_struct_returners) status.normalized_struct_returners = new Set();
	for (const name of normalizing) status.normalized_struct_returners.add(name);
}
