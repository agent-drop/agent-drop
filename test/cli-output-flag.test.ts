import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { addCommonOptions, outputFlag } from "../tools/lib/cli-utils";

// The program declares a global `-o, --output <file>`. A subcommand that
// declares its own `-o` never sees the value: Commander binds it to the program.
// `drop raw -o x.eml` and `drop download ... -o x` wrote to the default path for
// exactly that reason. These rebuild the same shape with the real helper.
function parse(argv: string[]) {
	let seen: Record<string, unknown> = {};
	const program = addCommonOptions(new Command().exitOverride());
	program
		.command("raw <inbox> <dropId>")
		.option("-o, --output <path>", "Output path")
		.action((_inbox, _dropId, opts) => {
			seen = opts;
		});
	program.parse(["bun", "drop", ...argv]);
	return { program, seen };
}

describe("outputFlag", () => {
	test("the subcommand's own -o is shadowed by the global one", () => {
		const { program, seen } = parse(["raw", "lisa", "d1", "-o", "x.eml"]);
		expect(seen.output).toBeUndefined();
		expect(program.opts().output).toBe("x.eml");
	});

	test("finds -o after the subcommand", () => {
		const { program, seen } = parse(["raw", "lisa", "d1", "-o", "x.eml"]);
		expect(outputFlag(seen, program)).toBe("x.eml");
	});

	test("finds -o before the subcommand", () => {
		const { program, seen } = parse(["-o", "y.eml", "raw", "lisa", "d1"]);
		expect(outputFlag(seen, program)).toBe("y.eml");
	});

	test("is undefined when nobody passed -o", () => {
		const { program, seen } = parse(["raw", "lisa", "d1"]);
		expect(outputFlag(seen, program)).toBeUndefined();
	});
});
