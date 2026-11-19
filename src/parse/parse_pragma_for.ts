import add_error from "../add_error.ts";
import NestedBlockNode from "../nodes/NestedBlockNode.ts";
import PragmaForNode from "../nodes/PragmaForNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

/**
 * `#for <binding> of <iterable> { ... }` — the compile-time field loop
 * (docs/COMPTIME.md stage 2). Body scope only: the arm is an
 * ordinary nested block pushed on the stack, so declarations inside it are
 * legal exactly like declarations in a `{ }` block statement (they die at
 * the arm's closing brace — which is also the per-iteration hygiene when
 * the loop unrolls).
 *
 * The iterable is parsed with the ordinary expression parser
 * (`META.info(T).fields` builds Access shapes); the comptime grammar is
 * enforced later, at expansion, by resolve_meta_iterable. `of` is the same
 * contextual spelling the runtime for-loop uses.
 */
export default function parse_pragma_for(status: ParseStatus): PragmaForNode {
	const start = get_index(status);
	consume(status); // #
	consume(status); // for

	// The binding: a plain identifier (one word token — word chars per the
	// tokenizer's definition).
	const binding_token = status.tokens[status.i];
	if (!binding_token || !/^[A-Za-z_]\w*$/.test(binding_token.value)) {
		add_error(status, "Expected #for binding name", get_index(status));
	}
	const binding = binding_token ? binding_token.value : "_";
	consume(status); // binding

	expect("of", status);
	const iterable = parse_expression(status);

	const block = new NestedBlockNode(get_index(status));
	expect("{", status);
	status.stack.push(block);
	parse_statement(status);
	expect("}", status);
	status.stack.pop();

	return new PragmaForNode(start, binding, iterable, block);
}
