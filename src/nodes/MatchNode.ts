import BaseNode from "./BaseNode.ts";
import BranchNode from "./BranchNode.ts";
import type ReturningNode from "./ReturningNode.ts";
import Type from "./Type.ts";

export default class MatchNode extends BaseNode implements ReturningNode {
	value: BaseNode;
	cases: { match_value: BaseNode; branch: BranchNode; params?: string[] }[];
	else_branch?: BranchNode;
	return_type: Type;
	has_return?: boolean;
	value_type?: string;
	/** Parsed from `try expr catch { arms }`: the arms address the RESULT's
	 *  error side (flat error arms), and the checker synthesizes the success
	 *  arm — the value flows through — before lowering the flat arms through
	 *  the same generated-match machinery `match` used to expose. Plain
	 *  matches never set this: their arms must be the scrutinee's own cases. */
	from_try?: boolean;
	/** Parsed as a statement (parser-stamped, the SpawnNode convention): the
	 *  try sits on its own line, not captured into a value. Statement position
	 *  lets a UNIT result (`out ! E`) mount — nothing flows, so the synthesized
	 *  success arm is empty and the arms are block branches or `return`s. In
	 *  expression position a unit result is still rejected (its ok path would
	 *  leave the expression unassigned). */
	is_statement?: boolean;
	/** Case names whose payload TRANSFERS OUT as the match's own value (the
	 *  synthesized `try/catch` success arm). The scrutinee-temp cleanup must
	 *  not free their payloads — the match result owns them now — and the
	 *  join analyses treat the arm value as an owned branch. */
	payload_moved_out?: string[];

	constructor(
		start: number,
		value: BaseNode,
		cases: { match_value: BaseNode; branch: BranchNode; params?: string[] }[] = [],
		else_branch?: BranchNode,
		return_type?: Type,
	) {
		super("match", start);
		this.value = value;
		this.cases = cases;
		this.else_branch = else_branch;
		this.return_type = return_type || new Type("");
		this.has_return = !!return_type;
	}
}
