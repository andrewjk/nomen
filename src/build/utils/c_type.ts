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
			return "long";
		case "uint32":
			return "unsigned long";
		case "int64":
			return "long long";
		case "uint64":
			return "unsigned long long";
		case "float":
			return "float";
		case "ufloat":
			// TODO: Uh
			return "unsigned float";
		case "float32":
			return "float";
		case "ufloat32":
			return "unsigned float";
		case "float64":
			return "double";
		case "ufloat64":
			return "unsigned double";
		case "char":
			// TODO:
			return "char";
		case "string":
			return "char*";
		default:
			return type;
	}
}
