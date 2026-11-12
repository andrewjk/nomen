import add_error from "../../add_error.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import BranchNode from "../../nodes/BranchNode.ts";
import LetNode from "../../nodes/LetNode.ts";
import MatchNode from "../../nodes/MatchNode.ts";
import type Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

type MatchCase = MatchNode["cases"][number];
type EnumLike = {
	name: string;
	source_name?: string;
	is_composed_error_set?: boolean;
	cases: { name: string; params: { name: string; type: Type }[] }[];
};

/**
 * ERRORS_PLAN stage 5 — the FLAT error-arm surface. A match over a Result
 * (`T ! E` or an explicit Result) accepts arms addressing the ERROR side
 * directly; the checker lowers them into nested matches the builders already
 * understand — zero new match or backend machinery:
 *
 *   match fetch(url) {
 *       case .ok(body) -> ...
 *       case .notfound -> ...          // resolves through `.fail`
 *       case .network(reason) -> ...   // binds the case payload
 *   }
 *
 * In a composed set (`T ! E1, E2`) the error side is the generated
 * origin-tagged enum, so arms may name the origin:
 *
 *   case LoadError.timeout     // a case channel of one member
 *   case LoadError(err)        // bind the whole member error
 *   case .timeout              // resolved across members; ambiguous = error
 *
 * Lowering collapses all grouped arms into ONE `.fail` arm at the first
 * grouped arm's position, whose body is the generated inner match (one more
 * level per origin tag for composed sets). Branches are MOVED, never
 * cloned: every branch is checked and built exactly once. Exhaustiveness is
 * enforced on the generated matches by the ordinary rules — covering a
 * member means covering all of its cases or binding the whole member
 * (`case E(err)`).
 *
 * The explicit forms stay untouched: `.fail(...)` remains the catch-all,
 * and mixing it with flat arms is rejected (both compete for the outer tag).
 */
export default function rewrite_flat_error_arms(
	match_node: MatchNode,
	match_type: Type,
	status: CheckStatus,
): void {
	const result_enum = status.enums.findLast((e) => e.name === match_type.name);
	if (result_enum?.template_name !== "Result") return;
	const fail_case = result_enum.cases.find((c) => c.name === "fail");
	if (!fail_case?.params[0]) return;
	const error_enum = status.enums.findLast((e) => e.name === fail_case.params[0].type.name) as
		| EnumLike
		| undefined;
	if (!error_enum) return;

	// The error side: one named enum or anonymous error enum (single
	// `T ! E` / `T ! [.case, ...]`), or the generated origin-tagged enum of
	// a composed set (`T ! E1, E2`).
	const composed = error_enum.is_composed_error_set === true;
	const owners: { key: string; enum: EnumLike }[] = composed
		? error_enum.cases
				.map((c) => {
					const member = status.enums.findLast((e) => e.name === c.params[0]?.type.name) as
						| EnumLike
						| undefined;
					return member ? { key: c.name, enum: member } : undefined;
				})
				.filter((o): o is { key: string; enum: EnumLike } => !!o)
		: [{ key: "", enum: error_enum }];
	if (owners.length === 0) return;

	const owner_for_enum_name = (name: string) =>
		owners.find((o) => o.enum.name === name || o.enum.source_name === name);
	const enum_declares = (owner: { enum: EnumLike }, case_name: string) =>
		owner.enum.cases.some((c) => c.name === case_name);

	interface Group {
		owner: { key: string; enum: EnumLike };
		whole?: MatchCase;
		flat: { case_name: string; arm: MatchCase }[];
		position: number;
	}
	const groups: Group[] = [];
	const group_of = (owner: { key: string; enum: EnumLike }, position: number): Group => {
		let group = groups.find((g) => g.owner === owner);
		if (!group) {
			group = { owner, flat: [], position };
			groups.push(group);
		}
		return group;
	};

	const arm_to_group = new Map<MatchCase, Group>();
	let has_explicit_fail = false;

	for (const [index, arm] of match_node.cases.entries()) {
		const pattern = arm.match_value;
		if (pattern.node_type === "value") {
			const value = (pattern as ValueNode).value;
			if (value === ".ok") continue;
			if (value === ".fail") {
				has_explicit_fail = true;
				continue;
			}
			if (value.startsWith(".") && value.length > 1 && !value.startsWith("..")) {
				const case_name = value.substring(1);
				const declaring = owners.filter((o) => enum_declares(o, case_name));
				if (declaring.length === 1) {
					const group = group_of(declaring[0], index);
					group.flat.push({ case_name, arm });
					arm_to_group.set(arm, group);
				} else if (declaring.length > 1) {
					add_error(
						status,
						`case '.${case_name}' is ambiguous in the error set (${declaring.map((o) => o.enum.name).join(", ")}) — spell the origin (\`${declaring[0].enum.name}.${case_name}\`)`,
						pattern.start,
					);
					// Keep a plain fail catch in place so the outer match stays
					// exhaustive — the build already failed on the ambiguity,
					// and a cascading non-exhaustive error helps nobody.
					arm.match_value = new ValueNode(pattern.start, ".fail");
					arm.params = undefined;
				}
				// 0 declaring owners: the ordinary arm check reports the unknown case.
				continue;
			}
			// `Enum(bindings)` — bind the whole error (or one composed member).
			if (arm.params?.length) {
				const owner = owner_for_enum_name(value);
				if (owner) {
					const group = group_of(owner, index);
					group.whole = arm;
					arm_to_group.set(arm, group);
				}
			}
			continue;
		}
		if (pattern.node_type === "access") {
			const access = pattern as AccessNode;
			if (access.access.node_type === "access_field" && access.target.node_type === "value") {
				const enum_name = (access.target as ValueNode).value;
				const case_name = (access.access as AccessFieldNode).name;
				if (
					enum_name === result_enum.name ||
					enum_name === result_enum.source_name ||
					enum_name === "Result"
				) {
					has_explicit_fail ||= case_name === "fail";
					continue;
				}
				const owner = owner_for_enum_name(enum_name);
				if (owner && enum_declares(owner, case_name)) {
					const group = group_of(owner, index);
					group.flat.push({ case_name, arm });
					arm_to_group.set(arm, group);
				}
			}
		}
	}

	if (arm_to_group.size === 0) return;

	if (has_explicit_fail) {
		add_error(
			status,
			`cannot mix flat error arms with a '.fail' arm — bind the error with 'case ${composed ? `${owners[0].enum.name}(err)` : ".fail(err)"}' or list the flat cases`,
			match_node.start,
		);
	}
	for (const group of groups) {
		if (group.whole && group.flat.length > 0) {
			add_error(
				status,
				`'case ${group.owner.enum.name}(err)' binds the whole error — remove the '${group.owner.enum.name}.case' arms for the same origin`,
				group.whole.match_value.start,
			);
		}
	}

	const shorthand = (start: number, case_name: string) => new ValueNode(start, `.${case_name}`);
	const branch_with = (node: BaseNode): BranchNode => {
		const branch = new BranchNode(node.start);
		branch.statements.push(new LetNode(node.start, node));
		return branch;
	};
	const inner_match = (scrutinee: BaseNode, arms: { pattern: BaseNode; arm: MatchCase }[]) => {
		const inner = new MatchNode(match_node.start, scrutinee);
		for (const { pattern, arm } of arms) {
			inner.cases.push({
				match_value: pattern,
				branch: arm.branch,
				params: arm.params,
			});
		}
		return inner;
	};
	const flat_patterns = (group: Group) =>
		group.flat.map(({ case_name, arm }) => ({
			pattern: shorthand(arm.match_value.start, case_name),
			arm,
		}));

	// The single synthesized outer `.fail` arm (no explicit `.fail` arm
	// exists — the mixing check above rejected that shape).
	let outer: MatchCase | undefined;
	if (!composed) {
		const group = groups[0];
		if (group.whole) {
			outer = {
				match_value: shorthand(match_node.start, "fail"),
				branch: group.whole.branch,
				params: group.whole.params,
			};
		} else {
			const tmp = `_flat_err_${status.var_name_counter.value++}`;
			outer = {
				match_value: shorthand(match_node.start, "fail"),
				branch: branch_with(
					inner_match(new ValueNode(match_node.start, tmp), flat_patterns(group)),
				),
				params: [tmp],
			};
		}
	} else {
		const anon_tmp = `_flat_err_${status.var_name_counter.value++}`;
		const member_arms = groups.map((group) => {
			if (group.whole) {
				return {
					pattern: shorthand(group.whole.match_value.start, group.owner.key),
					arm: group.whole,
				};
			}
			const member_tmp = `_flat_member_${status.var_name_counter.value++}`;
			const inner = inner_match(new ValueNode(match_node.start, member_tmp), flat_patterns(group));
			const wrapped: MatchCase = {
				match_value: shorthand(match_node.start, group.owner.key),
				branch: branch_with(inner),
				params: [member_tmp],
			};
			return { pattern: wrapped.match_value, arm: wrapped };
		});
		outer = {
			match_value: shorthand(match_node.start, "fail"),
			branch: branch_with(inner_match(new ValueNode(match_node.start, anon_tmp), member_arms)),
			params: [anon_tmp],
		};
	}

	// Rebuild the arm list: the synthesized outer arm takes the first grouped
	// arm's position; every grouped arm is removed in favor of it.
	const rebuilt: MatchCase[] = [];
	for (const arm of match_node.cases) {
		if (arm_to_group.has(arm)) {
			if (outer) {
				rebuilt.push(outer);
				outer = undefined;
			}
			continue;
		}
		rebuilt.push(arm);
	}
	match_node.cases = rebuilt;
}
