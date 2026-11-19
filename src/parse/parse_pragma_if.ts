import add_error from "../add_error.ts";
import { is_returning_node } from "../nodes/check_node_type.ts";
import LetNode from "../nodes/LetNode.ts";
import NestedBlockNode from "../nodes/NestedBlockNode.ts";
import PragmaIfNode from "../nodes/PragmaIfNode.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

/**
 * Compile-time conditionals (docs/COMPTIME.md stage 1), spelled with
 * the language's existing keywords:
 *
 *   #if <condition> { ... } else { ... }
 *
 *   #switch {
 *       case <condition> { ... }
 *       case <condition> { ... }
 *   } else { ... }
 *
 * `#switch` mirrors the runtime switch grammar exactly — subject-less,
 * `case`-prefixed conditions, `else` terminating the construct OUTSIDE the
 * braces — and needs no desugaring: a case condition IS a pragma condition,
 * so compound conditions (`case META.arch == "c" || ...`) evaluate through
 * the same tiny grammar (`META.arch`/`META.platform`, string/bool literals,
 * `== != && || !`, parentheses).
 *
 * Parsing reuses the ordinary expression parser so conditions build the
 * same OperationNode/ValueNode shapes a runtime `if` condition would; the
 * CONDITION grammar is enforced later, structurally, by
 * evaluate_pragma_condition when the checker folds the pragma. Both forms
 * produce a PragmaIfNode; folding is shared.
 */
export default function parse_pragma_if(status: ParseStatus): PragmaIfNode {
	const start = get_index(status);
	consume(status); // #
	consume(status); // if
	const pragma = new PragmaIfNode(start);
	status.stack.push(pragma);

	// `#if <condition> { ... }`
	pragma.branches.push({
		condition: parse_expression(status),
		block: parse_pragma_block(status, pragma),
	});

	// `else { ... }` — bare keyword, like a runtime if; optional.
	if (accept("else", status)) {
		pragma.branches.push({ condition: null, block: parse_pragma_block(status, pragma) });
	}

	status.stack.pop();
	return pragma;
}

export function parse_pragma_switch(status: ParseStatus): PragmaIfNode {
	const start = get_index(status);
	consume(status); // #
	consume(status); // switch
	const pragma = new PragmaIfNode(start);
	status.stack.push(pragma);

	expect("{", status);

	while (accept("case", status)) {
		const condition = parse_expression(status);
		pragma.branches.push({ condition, block: parse_pragma_case_arm(status, pragma) });
	}
	if (peek_current(status) === "else") {
		// The inside-the-braces spelling — point at the switch-shaped form.
		add_error(
			status,
			`#switch else arms sit outside the case braces: '#switch { cases } else { ... }'`,
			get_index(status),
		);
	}

	expect("}", status);

	// `else` terminates the construct at the top level, exactly like the
	// runtime switch (and the pragma stays on the stack while its arm
	// parses, so declarations inside are legal).
	if (accept("else", status)) {
		pragma.branches.push({ condition: null, block: parse_pragma_case_arm(status, pragma) });
	}

	status.stack.pop();
	return pragma;
}

/**
 * Parse one `#if` arm: `{ ... }`. The PRAGMA stays on the stack as the
 * attach parent (so declarations inside the arm are legal wherever the
 * pragma itself is — file scope, function body, nested block) and its
 * `statements` collector gathers the arm's contents; on `}` the collector
 * moves into a plain block holder that the checker's fold splices from.
 */
function parse_pragma_block(status: ParseStatus, pragma: PragmaIfNode): NestedBlockNode {
	const block_start = get_index(status);
	expect("{", status);
	pragma.statements = [];
	parse_statement(status);
	expect("}", status);
	const block = new NestedBlockNode(block_start, pragma.statements);
	pragma.statements = [];
	return block;
}

/**
 * Parse one `#switch` case arm — the same three shapes a runtime switch
 * branch takes: `=> expr` (return), `-> expr` (value statement), or a
 * `{ ... }` block. Block arms go through the pragma's statement collector
 * (see parse_pragma_block); the expression forms synthesize their one
 * statement directly, exactly like parse_switch's parse_case_branch.
 */
function parse_pragma_case_arm(status: ParseStatus, pragma: PragmaIfNode): NestedBlockNode {
	const block_start = get_index(status);
	const is_return = accept("=>", status);
	if (is_return || accept("->", status)) {
		let value;
		if (accept("(", status)) {
			value = parse_expression(status);
			expect(")", status);
		} else {
			value = parse_expression(status);
		}

		const statement = is_return
			? new ReturnNode(value.start, value)
			: new LetNode(value.start, value);
		if (is_return) {
			for (let i = status.stack.length - 1; i >= 0; i--) {
				if (is_returning_node(status.stack[i])) {
					(status.stack[i] as ReturningNode).has_return = true;
					if (status.stack[i].node_type === "func") break;
				}
			}
		}
		pragma.statements = [];
		return new NestedBlockNode(block_start, [statement]);
	}

	expect("{", status);
	pragma.statements = [];
	parse_statement(status);
	expect("}", status);
	const block = new NestedBlockNode(block_start, pragma.statements);
	pragma.statements = [];
	return block;
}
