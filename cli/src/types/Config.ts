export default interface Config {
	arch?: "c" | "aarch64";
	platform?: string;
	lib?: string;
	audit?: boolean;
	audit_runtime?: string;
}
