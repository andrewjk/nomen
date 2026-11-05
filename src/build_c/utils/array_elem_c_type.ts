import Type from "../../nodes/Type.ts";
import c_type from "./c_type.ts";

/**
 * The C type of a raw array's ELEMENT. A nested array's inner level is a
 * variable-size inline buffer referenced by pointer, so it renders as
 * `struct Array_<T>*`; everything else uses the normal element spelling.
 */
export default function array_elem_c_type(type: Type): string {
	if (type.elem) return `struct Array_${type.elem.name} *`;
	return c_type(type.name);
}
