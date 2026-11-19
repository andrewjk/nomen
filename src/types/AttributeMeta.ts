/**
 * One comptime literal argument of an attribute — `@rename("user_name")`,
 * `@level(3)`, `@weight(1.5)`, `@enabled(true)`. `text` is the literal's
 * value as written: string CONTENT (quotes stripped at parse), raw text
 * for ints/floats/bools.
 */
export interface AttributeValue {
	kind: "string" | "int" | "float" | "bool";
	text: string;
	start: number;
}

/**
 * An attribute — `@rename("user_name")` or a bare flag `@deprecated` —
 * attached to a struct, field or function declaration (docs/
 * docs/COMPTIME.md D1, stage 3). Pure metadata at parse time; the
 * checker surfaces it through META (`META.info(T).attr(...)`,
 * `field.has_attr(...)`). The compiler assigns no meaning to any
 * attribute name; names are snake_case lookup keys, not symbols.
 */
export default interface AttributeMeta {
	name: string;
	values: AttributeValue[];
	start: number;
}
