export default function c_type(type: string): string {
	switch (type) {
		case "bool":
			return "unsigned char";
		case "int":
			return "long";
		case "uint":
			return "unsigned long";
		case "int8":
			return "char";
		case "uint8":
			return "unsigned char";
		case "int16":
			return "short";
		case "uint16":
			return "unsigned short";
		case "int32":
			return "int";
		case "uint32":
			return "unsigned int";
		case "int64":
			return "long long";
		case "uint64":
			return "unsigned long long";
		case "float":
			// Echo `float` is 8 bytes on aarch64 (see aarch64_size.ts), so the C
			// backend must use `double` to match struct layout and arithmetic
			// precision. Using C `float` (4 bytes) causes checksum/energy drift.
			return "double";
		case "ufloat":
			return "double";
		case "float32":
			return "double";
		case "ufloat32":
			return "double";
		case "float64":
			return "double";
		case "ufloat64":
			return "double";
		case "char":
			// TODO:
			return "char";
		case "string":
			return "char*";
		case "func":
			return "void*";
		case "null":
			return "void*";
		default:
			return type;
	}
}
