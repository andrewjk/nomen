export default function aarch64_type(type: string): string {
	switch (type) {
		case "bool":
			return ".byte";
		case "int":
		case "uint":
		case "int64":
		case "uint64":
		case "string":
			return ".quad";
		case "int8":
		case "uint8":
		case "char":
			return ".byte";
		case "int16":
		case "uint16":
			return ".short";
		case "int32":
		case "uint32":
			return ".long";
		case "float":
		case "float32":
		case "ufloat":
		case "ufloat32":
			return ".double";
		case "float64":
		case "ufloat64":
			return ".double";
		default:
			return ".quad";
	}
}
