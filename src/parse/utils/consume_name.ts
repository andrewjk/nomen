import add_error from "../../add_error.ts";
import { RESERVED_WORDS } from "../../keywords.ts";
import type ParseStatus from "../ParseStatus.ts";
import consume from "./consume.ts";

/**
 * Consume a token as a declared name, reporting an error when it is a
 * reserved word. The name is still returned so the parser can continue and
 * collect further errors.
 */
export default function consume_name(status: ParseStatus): string {
	const token = status.tokens[status.i];
	const name = consume(status);
	if (RESERVED_WORDS.has(name)) {
		add_error(
			status,
			`'${name}' is a reserved word and cannot be used as a name`,
			token ? token.i : 0,
		);
	}
	return name;
}
