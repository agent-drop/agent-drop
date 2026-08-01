/**
 * CLI Utilities for standardized tool output
 *
 * Vendored into agent-drop, pruned to what the `drop` CLI actually uses:
 * output formatting (text/json/yaml/csv/markdown), common Commander options,
 * and a quiet-aware progress logger.
 */

import type { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as yaml from "yaml";

// ============================================================================
// Types
// ============================================================================

export type OutputFormat = "text" | "json" | "yaml" | "csv" | "markdown";

export interface OutputOptions {
	format?: OutputFormat;
	output?: string;
	quiet?: boolean;
	verbose?: boolean;
}

export interface TableData {
	headers: string[];
	rows: (string | number | boolean | null | undefined)[][];
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Format and output data according to the specified format
 *
 * @param data - The data to output (object, array, or primitive)
 * @param options - Output options (format, file, quiet)
 * @param textFormatter - Optional function to format data as text (for custom formatting)
 */
export function formatOutput(
	data: unknown,
	options: OutputOptions,
	textFormatter?: (data: unknown) => string,
): void {
	const format = options.format || "text";

	let output: string;

	switch (format) {
		case "json":
			output = JSON.stringify(data, null, 2);
			break;

		case "yaml":
			output = yaml.stringify(data);
			break;

		case "csv":
			output = toCsv(data);
			break;

		case "markdown":
			output = toMarkdown(data);
			break;
		default:
			if (textFormatter) {
				output = textFormatter(data);
			} else if (typeof data === "string") {
				output = data;
			} else {
				// Default: pretty JSON for objects
				output = JSON.stringify(data, null, 2);
			}
			break;
	}

	// Write to file or stdout
	if (options.output) {
		fs.writeFileSync(options.output, output, "utf8");
		if (!options.quiet) {
			console.error(chalk.green(`Written to ${options.output}`));
		}
	} else {
		console.log(output);
	}
}

/**
 * Convert data to CSV format
 * Handles arrays of objects or TableData format
 */
export function toCsv(data: unknown): string {
	// Handle TableData format
	if (isTableData(data)) {
		const lines: string[] = [];
		lines.push(data.headers.map(escapeCsvField).join(","));
		for (const row of data.rows) {
			lines.push(row.map((v) => escapeCsvField(String(v ?? ""))).join(","));
		}
		return lines.join("\n");
	}

	// Handle array of objects
	if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
		const headers = Object.keys(data[0] as Record<string, unknown>);
		const lines: string[] = [];

		lines.push(headers.map(escapeCsvField).join(","));

		for (const row of data) {
			const values = headers.map((h) => {
				const val = (row as Record<string, unknown>)[h];
				return escapeCsvField(String(val ?? ""));
			});
			lines.push(values.join(","));
		}

		return lines.join("\n");
	}

	// Fallback: stringify
	return String(data);
}

/**
 * Escape a CSV field (quote if contains comma, newline, or quote)
 */
function escapeCsvField(field: string): string {
	if (field.includes(",") || field.includes("\n") || field.includes('"')) {
		return `"${field.replace(/"/g, '""')}"`;
	}
	return field;
}

/**
 * Check if data is TableData format
 */
function isTableData(data: unknown): data is TableData {
	return (
		typeof data === "object" &&
		data !== null &&
		"headers" in data &&
		"rows" in data &&
		Array.isArray((data as TableData).headers) &&
		Array.isArray((data as TableData).rows)
	);
}

/**
 * Convert data to Markdown format
 * Handles arrays of objects as tables
 */
export function toMarkdown(data: unknown): string {
	// Handle TableData format
	if (isTableData(data)) {
		const lines: string[] = [];
		lines.push(`| ${data.headers.join(" | ")} |`);
		lines.push(`| ${data.headers.map(() => "---").join(" | ")} |`);
		for (const row of data.rows) {
			lines.push(`| ${row.map((v) => String(v ?? "")).join(" | ")} |`);
		}
		return lines.join("\n");
	}

	// Handle array of objects as table
	if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
		const headers = Object.keys(data[0] as Record<string, unknown>);
		const lines: string[] = [];

		lines.push(`| ${headers.join(" | ")} |`);
		lines.push(`| ${headers.map(() => "---").join(" | ")} |`);

		for (const row of data) {
			const values = headers.map((h) => {
				const val = (row as Record<string, unknown>)[h];
				return String(val ?? "");
			});
			lines.push(`| ${values.join(" | ")} |`);
		}

		return lines.join("\n");
	}

	// Handle plain object
	if (typeof data === "object" && data !== null && !Array.isArray(data)) {
		const lines: string[] = [];
		for (const [key, value] of Object.entries(data)) {
			lines.push(`**${key}:** ${String(value)}`);
		}
		return lines.join("\n");
	}

	// Fallback
	return String(data);
}

// ============================================================================
// Commander.js Helpers
// ============================================================================

/**
 * Add common CLI options to a Commander program
 *
 * Adds: --format, --output, --quiet, --verbose
 */
export function addCommonOptions(program: Command): Command {
	return program
		.option("-f, --format <format>", "Output format: text, json, yaml, csv, markdown", "text")
		.option("-o, --output <file>", "Write output to file instead of stdout")
		.option("-q, --quiet", "Suppress progress output, only show result")
		.option("-v, --verbose", "Enable verbose debug logging");
}

/**
 * Create a progress logger that respects --quiet mode
 */
export function createLogger(quiet?: boolean) {
	return {
		log: (...args: unknown[]) => {
			if (!quiet) console.error(...args);
		},
		info: (msg: string) => {
			if (!quiet) console.error(chalk.blue(msg));
		},
		success: (msg: string) => {
			if (!quiet) console.error(chalk.green(msg));
		},
		warn: (msg: string) => {
			if (!quiet) console.error(chalk.yellow(msg));
		},
		error: (msg: string) => {
			console.error(chalk.red(msg));
		},
		dim: (msg: string) => {
			if (!quiet) console.error(chalk.dim(msg));
		},
		progress: (char: string = ".") => {
			if (!quiet) process.stderr.write(char);
		},
		newline: () => {
			if (!quiet) console.error();
		},
		header: (title: string) => {
			if (!quiet) console.error(chalk.bold.cyan(`\n=== ${title} ===\n`));
		},
	};
}
