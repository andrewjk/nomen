export default interface CompileError {
	message: string;
	start: number;
	line: number;
	column: number;
}
