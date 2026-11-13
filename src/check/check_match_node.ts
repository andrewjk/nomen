import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import BranchNode from "../nodes/BranchNode.ts";
import LetNode from "../nodes/LetNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import block_always_returns from "./utils/always_returns.ts";
import clone_status from "./utils/clone_status.ts";
import rewrite_flat_error_arms, { reject_flat_error_arms } from "./utils/flat_error_arms.ts";
import { intersect_moved_variables, outer_scope_moved } from "./utils/moved_variables.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

export default function check_match_node(match_node: MatchNode, status: CheckStatus) {
	check_node(match_node.value, status);
	const match_type = type_from_value_node(match_node.value, status);
	match_node.value_type = match_type.name;

	// `try expr catch { arms }` (ERRORS.md): the arms address the RESULT's
	// error side. Gate the scrutinee, then synthesize the success arm — its
	// value flows through as the expression's value — so the ordinary arm
	// typing (`->` arms are returns of the match) and exhaustiveness apply
	// unchanged, and `rewrite_flat_error_arms` below lowers the catch arms
	// into the generated matches the builders already understand.
	if (match_node.from_try) {
		if (!mount_try_catch(match_node, match_type, status)) return;
	} else if (reject_flat_error_arms(match_node, match_type, status)) {
		// `match` is the scrutinee's own cases only; the error side is
		// `try/catch`'s job. The report is the whole diagnostic — skip the
		// cascading unknown-case arm checks.
		return;
	}
	// An arm whose branch yields its own case BINDING transfers the payload
	// out as the match's value: `case .ok(v) -> v` (or `{ return v }`). The
	// scrutinee-temp cleanup must keep that payload alive and the join must
	// not dup it (the same contract `try/catch`'s synthesized success arm
	// uses). ONLY for call-shaped scrutinees: the match materializes those
	// into a temp it owns, so a moved-out payload would otherwise be freed
	// under the match's value. A variable/field scrutinee is OWNED by its
	// declaration, whose scope-exit reclaim still frees the payload — there
	// the join's dup is the correct copy contract. Conservative: one binding
	// per case, yielded directly.
	if (!match_node.from_try && scrutinee_is_owned_temp(match_node)) {
		mark_moved_out_case_bindings(match_node);
	}

	// ERRORS_PLAN stage 5: flat error arms (`.notfound`, `LoadError.timeout`,
	// `LoadError(err)`) lower into the nested matches the builders already
	// understand. Runs before the arm loop so the synthesized structure is
	// what gets checked (and exhaustiveness applies per level). With flat
	// arms retired from plain `match`, this only fires for `try/catch`.
	rewrite_flat_error_arms(match_node, match_type, status);

	// The scrutinee's pending hoisted temps (an argument hoisted out of the
	// match value — `_param_0 = [1, 2, 3]`) belong to the STATEMENT this
	// match sits in: they must emit before the match value, which already
	// references them. The arm clones below copy status.allocations, and
	// promote_allocations would then attach the scrutinee's temps to a
	// branch binding — the C builder emits that binding's declaration
	// inside the arm while the match value still references the temp
	// (use of undeclared identifier `_param_0`). Park them for the arms
	// and restore afterwards.
	const scrutinee_allocations = status.allocations;
	status.allocations = [];

	status.stack.push(match_node);

	// The enclosing scope's values length when the arm clones are taken:
	// moved names whose innermost declaration sits at or beyond this index
	// are arm-local (a case binding or a fresh local) and must not merge.
	const arms_base = status.values.length;

	let branch_statuses: CheckStatus[] = [];

	for (let match_case of match_node.cases) {
		const old_expected_type = status.expected_type;
		status.expected_type = match_type;
		check_node(match_case.match_value, status);
		status.expected_type = old_expected_type;
		const case_type = type_from_value_node(match_case.match_value, status);
		if (match_type.name && case_type.name && match_type.name !== case_type.name) {
			add_error(
				status,
				`Match case type ${type_name(case_type)} does not match value type ${type_name(match_type)}`,
				match_case.match_value.start,
			);
		}

		let case_status = clone_status(status);

		// Bind associated-data payloads as locals in the branch scope so the
		// bound names (e.g. `code` in `case .error(code)`) resolve.
		if (matchCaseHasParams(match_case) && match_type.name) {
			const enum_node = status.enums.find((e) => e.name === match_type.name);
			const case_name = extract_enum_case_name(match_case.match_value, match_type.name);
			const enum_case = enum_node?.cases.find((c) => c.name === case_name);
			if (!enum_case) {
				add_error(
					status,
					`Unknown enum case: ${case_name} on ${match_type.name}`,
					match_case.match_value.start,
				);
			} else if (enum_case.params.length !== match_case.params!.length) {
				add_error(
					status,
					`Case ${case_name} expects ${enum_case.params.length} binding(s), got ${match_case.params!.length}`,
					match_case.match_value.start,
				);
			} else {
				for (let i = 0; i < match_case.params!.length; i++) {
					case_status.values.push({
						declaration: "var",
						name: match_case.params![i],
						type: enum_case.params[i].type,
						is_set: true,
					});
				}
			}
		}

		check_block_node(match_case.branch, case_status);
		branch_statuses.push(case_status);
	}

	if (match_node.else_branch) {
		let else_status = clone_status(status);
		check_block_node(match_node.else_branch, else_status);
		branch_statuses.push(else_status);
	}

	status.stack.pop();

	// Restore the scrutinee's pending temps (plus anything the arms parked
	// here): the enclosing statement's promote attaches them ahead of
	// itself, before the match value that references them.
	status.allocations = scrutinee_allocations.concat(status.allocations);

	for (let [i, value] of status.values.entries()) {
		if (value.declaration === "const" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			} else if (set_count > 0) {
				add_error(status, `Const set incompletely: ${value.name}`, match_node.start);
			}
		}

		if (value.declaration === "var" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			}
		}

		// Borrow invalidation: a borrow invalidated in any case (or else) that
		// can fall through is invalidated afterwards — either may have run.
		if (branch_statuses.some((bs) => bs.values[i]?.borrow_invalidated)) {
			value.borrow_invalidated = true;
		}
	}

	// Moved-variable reconciliation across the arms (same merge as if/else):
	// the arm clones start from the parent's moved set, and a name stays
	// moved after the match only when every arm that can fall through ends
	// with it moved (both-moved ⇒ moved). An arm that always exits (a guard
	// case with return) contributes nothing — its path dies — and a possible
	// no-arm path (non-exhaustive match without else) joins the parent's own
	// facts, since that path leaves the match with the parent's state.
	{
		const contributors: Array<Set<string> | undefined> = [];
		branch_statuses.forEach((bs, i) => {
			const branch =
				i < match_node.cases.length ? match_node.cases[i].branch : match_node.else_branch;
			if (branch && !block_always_returns(branch)) {
				contributors.push(outer_scope_moved(bs, arms_base));
			}
		});
		if (!match_is_exhaustive(match_node, match_type, status)) {
			contributors.push(status.moved_variables);
		}
		if (contributors.length > 0) {
			status.moved_variables = intersect_moved_variables(contributors);
		}
	}

	if (!match_node.else_branch) {
		check_exhaustiveness(match_node, match_type, status);
	}
}

/**
 * Whether every path through the match enters an arm — an else branch, or a
 * case set covering the whole matched enum/bool. The error-free counterpart
 * of check_exhaustiveness, used by the moved-variable reconciliation to
 * detect the fall-through-with-no-arm path (whose post-match state is the
 * parent's).
 */
function match_is_exhaustive(
	match_node: MatchNode,
	match_type: ReturnType<typeof type_from_value_node>,
	status: CheckStatus,
): boolean {
	if (match_node.else_branch) return true;
	if (!match_type.name) return false;

	const enum_node = status.enums.find((e) => e.name === match_type.name);
	if (enum_node) {
		const covered = new Set<string>();
		for (const match_case of match_node.cases) {
			const case_name = extract_enum_case_name(match_case.match_value, match_type.name);
			if (case_name) covered.add(case_name);
		}
		return enum_node.cases.every((c) => covered.has(c.name));
	}

	if (match_type.name === "bool") {
		const covered = new Set<string>();
		for (const match_case of match_node.cases) {
			if (match_case.match_value.node_type === "value") {
				const val = (match_case.match_value as ValueNode).value;
				if (val === "true" || val === "false") covered.add(val);
			}
		}
		return covered.has("true") && covered.has("false");
	}

	return false;
}

function check_exhaustiveness(
	match_node: MatchNode,
	match_type: ReturnType<typeof type_from_value_node>,
	status: CheckStatus,
) {
	if (!match_type.name) return;

	const enum_node = status.enums.find((e) => e.name === match_type.name);
	if (enum_node) {
		const covered = new Set<string>();
		for (const match_case of match_node.cases) {
			const case_name = extract_enum_case_name(match_case.match_value, match_type.name);
			if (case_name) covered.add(case_name);
		}
		const missing = enum_node.cases.map((c) => c.name).filter((n) => !covered.has(n));
		if (missing.length > 0) {
			add_error(
				status,
				`Non-exhaustive match: missing cases ${missing.join(", ")}`,
				match_node.start,
			);
		}
		return;
	}

	if (match_type.name === "bool") {
		const covered = new Set<string>();
		for (const match_case of match_node.cases) {
			if (match_case.match_value.node_type === "value") {
				const val = (match_case.match_value as ValueNode).value;
				if (val === "true" || val === "false") covered.add(val);
			}
		}
		const missing: string[] = [];
		if (!covered.has("true")) missing.push("true");
		if (!covered.has("false")) missing.push("false");
		if (missing.length > 0) {
			add_error(
				status,
				`Non-exhaustive match: missing cases ${missing.join(", ")}`,
				match_node.start,
			);
		}
		return;
	}

	add_error(status, `Non-exhaustive match: missing else branch`, match_node.start);
}

function matchCaseHasParams(match_case: {
	match_value: BaseNode;
	branch: BranchNode;
	params?: string[];
}): boolean {
	return !!match_case.params && match_case.params.length > 0;
}

function extract_enum_case_name(
	node: import("../nodes/BaseNode.ts").default,
	enum_name: string,
): string | null {
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (vn.is_enum_shorthand && vn.value.startsWith(enum_name + "_")) {
			return vn.value.substring(enum_name.length + 1);
		}
	}
	if (node.node_type === "access") {
		const an = node as AccessNode;
		if (an.access.node_type === "access_field") {
			const af = an.access as AccessFieldNode;
			if (an.target.node_type === "value") {
				const target = an.target as ValueNode;
				if (target.value === enum_name) {
					return af.name;
				}
			}
		}
	}
	return null;
}

/**
 * Synchronize a `try expr catch { ... }` node's arms for checking: gate the
 * scrutinee to a `T ! E` result with a success value, reject explicit
 * `.ok`/`.fail` arms (they compete with the synthesized structure), then
 * prepend the success arm — binding the ok payload and yielding it, so the
 * match's return type infers T and every catch arm is checked against it
 * (the arm typing model: `->` arms are returns of the match). A unit result
 * (`out ! E`) has no value to flow through, so it is rejected (propagate
 * with `!`, discard with `var _ =`, or match explicitly). Returns false when
 * the gate reported (the caller skips arm checking).
 */
function mount_try_catch(
	match_node: MatchNode,
	match_type: import("../nodes/Type.ts").default,
	status: CheckStatus,
): boolean {
	const result_enum = status.enums.findLast((e) => e.name === match_type.name);
	const ok_case = result_enum?.cases.find((c) => c.name === "ok");
	const fail_case = result_enum?.cases.find((c) => c.name === "fail");
	if (result_enum?.template_name !== "Result" || !ok_case?.params[0] || !fail_case?.params[0]) {
		// A unit result (`out ! E`) has no success VALUE to flow through —
		// its ok path would leave the expression unassigned. Propagate with
		// `!`, discard with `var _ =`, or match the result explicitly.
		add_error(
			status,
			`'try' needs a 'T ! E' result with a success value — '${type_name(match_type)}' has none; propagate with '!' or match it`,
			match_node.start,
		);
		return false;
	}

	for (const arm of match_node.cases) {
		const arm_text = match_case_shorthand(arm.match_value);
		if (arm_text === ".ok") {
			add_error(
				status,
				`'case .ok' is the success side — 'try/catch' handles the error side; the success value flows through`,
				arm.match_value.start,
			);
			return false;
		}
		if (arm_text === ".fail") {
			add_error(
				status,
				`'case .fail' competes with 'catch' — list the error cases flat (or bind a whole member with 'case E(err)')`,
				arm.match_value.start,
			);
			return false;
		}
	}

	const ok_start = match_node.start;
	const tmp = `_try_val_${status.var_name_counter.value++}`;
	const branch = new BranchNode(ok_start);
	const value = new ValueNode(ok_start, tmp);
	// A CALL-shaped scrutinee is materialized into a temp the match owns: the
	// success payload TRANSFERS OUT (stamp the branch value owned so the join
	// does not dup it, and record the case so the temp cleanup keeps it). A
	// variable/field scrutinee is owned by its declaration, whose reclaim
	// still frees the payload — there the ordinary copy contract applies
	// (the join dups the binding into the result).
	if (scrutinee_is_owned_temp(match_node)) {
		value.is_case_move = true;
		match_node.payload_moved_out = [ok_case.name];
	}
	branch.statements.push(new LetNode(ok_start, value));
	match_node.cases.unshift({
		match_value: new ValueNode(ok_start, ".ok"),
		branch,
		params: [tmp],
	});
	return true;
}

/** The arm pattern's shorthand spelling (`.case`), when it has one. */
function match_case_shorthand(pattern: BaseNode): string | undefined {
	if (pattern.node_type !== "value") return undefined;
	const value = (pattern as ValueNode).value;
	return value.startsWith(".") && value.length > 1 ? value : undefined;
}

/**
 * Whether the builders materialize the scrutinee into an OWNED temp (a call
 * — free function or method). Mirrors both match builders' `scrutinee_is_call`
 * gate: the temp is the match's own copy, so a moved-out payload would
 * otherwise be reclaimed under the match's value.
 */
function scrutinee_is_owned_temp(node: { value: BaseNode }): boolean {
	const value = node.value;
	return (
		value.node_type === "func_call" ||
		(value.node_type === "access" && (value as AccessNode).access.node_type === "access_func")
	);
}

/**
 * Stamp arms whose branch yields exactly their own case binding — the
 * payload TRANSFERS OUT as the match's value (`case .ok(v) -> v`,
 * `case .fail(err) { return err }`). The arm value joins the owned-branch
 * analysis (no boundary dup) and the case joins `payload_moved_out` (the
 * scrutinee cleanup keeps its payload). Restricted to single-payload cases
 * yielded by a single bare `let`/`return` statement — anything else keeps
 * the (freeing) copy contract.
 */
function mark_moved_out_case_bindings(match_node: MatchNode): void {
	for (const arm of match_node.cases) {
		if (arm.params?.length !== 1) continue;
		const param = arm.params[0];
		const statements = arm.branch.statements;
		if (statements.length !== 1) continue;
		const statement = statements[0];
		const yielded =
			statement.node_type === "let" || statement.node_type === "return"
				? (statement as { value?: BaseNode }).value
				: undefined;
		if (!yielded || yielded.node_type !== "value") continue;
		if ((yielded as ValueNode).value !== param) continue;
		(yielded as ValueNode).is_case_move = true;
		const case_name = match_case_shorthand(arm.match_value)?.substring(1);
		if (!case_name) continue;
		if (!match_node.payload_moved_out) match_node.payload_moved_out = [];
		if (!match_node.payload_moved_out.includes(case_name)) {
			match_node.payload_moved_out.push(case_name);
		}
	}
}
