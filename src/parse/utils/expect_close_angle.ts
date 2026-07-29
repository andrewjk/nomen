import add_error from "../../add_error.ts";
import type ParseStatus from "../ParseStatus.ts";
import get_index from "./get_index.ts";

// Consume one closing `>` of a generic argument / type-parameter list.
//
// The tokenizer greedily matches `>>` (and would match `>>>` if it were a
// registered symbol) as the bitwise-shift operator before considering two
// separate `>` tokens. So when nested generics abut their closes — e.g.
// `Greetable<Wrap<int>>` lexes as `Greetable < Wrap < int >>` — a plain
// `expect(">")` fails because the current token is `>>`, not `>`.
//
// This helper peels a single `>` off the current token in place: a `>>`
// becomes a `>` (one angle consumed, one left at the same index for the
// enclosing generic's close), and a plain `>` is consumed normally. Because
// the peel keeps the remaining angle at the current index (no advance),
// arbitrarily deep nesting works — `A<B<C<int>>>` lexes as `>>` + `>`, and
// three successive calls drain both tokens correctly. Genuine shift
// operators are unaffected: a real `a >> b` never reaches here because this
// is only called at generic-close positions.
export default function expect_close_angle(status: ParseStatus): boolean {
	if (status.i < status.tokens.length) {
		const token = status.tokens[status.i];
		if (token.value === ">") {
			status.i += 1;
			return true;
		}
		if (token.value === ">>") {
			// Peel one angle off; leave the remaining `>` at the current index.
			token.value = ">";
			return true;
		}
		if (token.value === ">>>") {
			token.value = ">>";
			return true;
		}
		add_error(status, "Expected >", get_index(status));
	} else {
		const last = status.tokens.at(-1);
		add_error(status, "Expected token", last ? last.i + last.value.length : 0);
	}
	return false;
}
