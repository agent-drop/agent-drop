/**
 * CLI Utilities for standardized tool output
 *
 * Provides:
 * - Output formatting (JSON, YAML, CSV, text, markdown)
 * - Common CLI options (--format, --output, --quiet, --verbose)
 * - File writing utilities
 */

import { Command } from "commander"
import chalk from "chalk"
import * as fs from "fs"
import * as yaml from "yaml"

// ============================================================================
// Types
// ============================================================================

export type OutputFormat = "text" | "json" | "yaml" | "csv" | "markdown"

export interface OutputOptions {
	format?: OutputFormat
	output?: string
	quiet?: boolean
	verbose?: boolean
}

export interface TableData {
	headers: string[]
	rows: (string | number | boolean | null | undefined)[][]
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
	textFormatter?: (data: unknown) => string
): void {
	const format = options.format || "text"

	let output: string

	switch (format) {
		case "json":
			output = JSON.stringify(data, null, 2)
			break

		case "yaml":
			output = yaml.stringify(data)
			break

		case "csv":
			output = toCsv(data)
			break

		case "markdown":
			output = toMarkdown(data)
			break

		case "text":
		default:
			if (textFormatter) {
				output = textFormatter(data)
			} else if (typeof data === "string") {
				output = data
			} else {
				// Default: pretty JSON for objects
				output = JSON.stringify(data, null, 2)
			}
			break
	}

	// Write to file or stdout
	if (options.output) {
		fs.writeFileSync(options.output, output, "utf8")
		if (!options.quiet) {
			console.error(chalk.green(`Written to ${options.output}`))
		}
	} else {
		console.log(output)
	}
}

/**
 * Convert data to CSV format
 * Handles arrays of objects or TableData format
 */
export function toCsv(data: unknown): string {
	// Handle TableData format
	if (isTableData(data)) {
		const lines: string[] = []
		lines.push(data.headers.map(escapeCsvField).join(","))
		for (const row of data.rows) {
			lines.push(row.map(v => escapeCsvField(String(v ?? ""))).join(","))
		}
		return lines.join("\n")
	}

	// Handle array of objects
	if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
		const headers = Object.keys(data[0] as Record<string, unknown>)
		const lines: string[] = []

		lines.push(headers.map(escapeCsvField).join(","))

		for (const row of data) {
			const values = headers.map(h => {
				const val = (row as Record<string, unknown>)[h]
				return escapeCsvField(String(val ?? ""))
			})
			lines.push(values.join(","))
		}

		return lines.join("\n")
	}

	// Fallback: stringify
	return String(data)
}

/**
 * Escape a CSV field (quote if contains comma, newline, or quote)
 */
function escapeCsvField(field: string): string {
	if (field.includes(",") || field.includes("\n") || field.includes('"')) {
		return `"${field.replace(/"/g, '""')}"`
	}
	return field
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
	)
}

/**
 * Convert data to Markdown format
 * Handles arrays of objects as tables
 */
export function toMarkdown(data: unknown): string {
	// Handle TableData format
	if (isTableData(data)) {
		const lines: string[] = []
		lines.push("| " + data.headers.join(" | ") + " |")
		lines.push("| " + data.headers.map(() => "---").join(" | ") + " |")
		for (const row of data.rows) {
			lines.push("| " + row.map(v => String(v ?? "")).join(" | ") + " |")
		}
		return lines.join("\n")
	}

	// Handle array of objects as table
	if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
		const headers = Object.keys(data[0] as Record<string, unknown>)
		const lines: string[] = []

		lines.push("| " + headers.join(" | ") + " |")
		lines.push("| " + headers.map(() => "---").join(" | ") + " |")

		for (const row of data) {
			const values = headers.map(h => {
				const val = (row as Record<string, unknown>)[h]
				return String(val ?? "")
			})
			lines.push("| " + values.join(" | ") + " |")
		}

		return lines.join("\n")
	}

	// Handle plain object
	if (typeof data === "object" && data !== null && !Array.isArray(data)) {
		const lines: string[] = []
		for (const [key, value] of Object.entries(data)) {
			lines.push(`**${key}:** ${String(value)}`)
		}
		return lines.join("\n")
	}

	// Fallback
	return String(data)
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
		.option(
			"-f, --format <format>",
			"Output format: text, json, yaml, csv, markdown",
			"text"
		)
		.option(
			"-o, --output <file>",
			"Write output to file instead of stdout"
		)
		.option(
			"-q, --quiet",
			"Suppress progress output, only show result"
		)
		.option(
			"-v, --verbose",
			"Enable verbose debug logging"
		)
}

/**
 * Create a progress logger that respects --quiet mode
 */
export function createLogger(quiet?: boolean) {
	return {
		log: (...args: unknown[]) => {
			if (!quiet) console.error(...args)
		},
		info: (msg: string) => {
			if (!quiet) console.error(chalk.blue(msg))
		},
		success: (msg: string) => {
			if (!quiet) console.error(chalk.green(msg))
		},
		warn: (msg: string) => {
			if (!quiet) console.error(chalk.yellow(msg))
		},
		error: (msg: string) => {
			console.error(chalk.red(msg))
		},
		dim: (msg: string) => {
			if (!quiet) console.error(chalk.dim(msg))
		},
		progress: (char: string = ".") => {
			if (!quiet) process.stderr.write(char)
		},
		newline: () => {
			if (!quiet) console.error()
		},
		header: (title: string) => {
			if (!quiet) console.error(chalk.bold.cyan(`\n=== ${title} ===\n`))
		}
	}
}

// ============================================================================
// Text Formatting Helpers
// ============================================================================

/**
 * Format a date as ISO string or relative time
 */
export function formatDate(date: Date | string | number, relative = false): string {
	const d = new Date(date)

	if (relative) {
		const now = Date.now()
		const diff = now - d.getTime()
		const mins = Math.floor(diff / 60000)
		const hours = Math.floor(diff / 3600000)
		const days = Math.floor(diff / 86400000)

		if (mins < 1) return "just now"
		if (mins < 60) return `${mins}m ago`
		if (hours < 24) return `${hours}h ago`
		if (days < 7) return `${days}d ago`
		return d.toLocaleDateString()
	}

	return d.toISOString()
}

/**
 * Format bytes as human-readable size
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Render a Unicode progress bar with a colored percentage label.
 * Color: cyan <50%, yellow 50-99%, green at 100%.
 */
export function progressBar(pct: number, width: number): string {
	const filled = Math.round((pct / 100) * width)
	const empty = width - filled
	const bar = "█".repeat(filled) + "░".repeat(empty)
	const color = pct >= 100 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.cyan
	return color(`${bar} ${pct.toFixed(0).padStart(3)}%`)
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
	if (str.length <= maxLength) return str
	return str.substring(0, maxLength - 3) + "..."
}

/**
 * Pad string to fixed width
 */
export function pad(str: string, width: number, align: "left" | "right" = "left"): string {
	if (str.length >= width) return str.substring(0, width)
	const padding = " ".repeat(width - str.length)
	return align === "left" ? str + padding : padding + str
}

// ============================================================================
// Preflight Check Utilities
// ============================================================================

export interface PreflightCheck {
	name: string
	ok: boolean
	message: string
}

export interface PreflightResult {
	ok: boolean
	checks: PreflightCheck[]
}

/**
 * Create a preflight check result
 */
export function createPreflightResult(): PreflightResult {
	return { ok: true, checks: [] }
}

/**
 * Add a check to a preflight result
 */
export function addCheck(result: PreflightResult, name: string, ok: boolean, message: string): void {
	result.checks.push({ name, ok, message })
	if (!ok) result.ok = false
}

/**
 * Check if running on macOS
 */
export function checkMacOS(result: PreflightResult): void {
	if (process.platform === "darwin") {
		addCheck(result, "Platform", true, "macOS")
	} else {
		addCheck(result, "Platform", false, `Requires macOS (running on ${process.platform})`)
	}
}

/**
 * Check if a file/directory is accessible
 */
export function checkFileAccess(result: PreflightResult, name: string, path: string, hint?: string): void {
	if (fs.existsSync(path)) {
		addCheck(result, name, true, "Accessible")
	} else {
		const msg = hint ? `Not accessible - ${hint}` : "Not accessible"
		addCheck(result, name, false, msg)
	}
}

/**
 * Check if an environment variable is set
 */
export function checkEnvVar(result: PreflightResult, varName: string, hint?: string): void {
	const value = process.env[varName]
	if (value) {
		// Show first few chars for verification
		const preview = value.length > 8 ? `${value.slice(0, 8)}...` : value
		addCheck(result, varName, true, `Set (${preview})`)
	} else {
		const msg = hint ? `Not set - ${hint}` : "Not set"
		addCheck(result, varName, false, msg)
	}
}

/**
 * Format preflight result for display (used in --help and --preflight-check)
 * This is the SINGLE SOURCE OF TRUTH for preflight status formatting.
 *
 * @param result - The preflight check result
 * @param colored - Whether to use chalk colors (true for terminal, false for --help interpolation)
 */
export function formatPreflightStatus(result: PreflightResult, colored = false): string {
	const lines: string[] = []

	// Header with prominent status
	if (result.ok) {
		lines.push(colored ? chalk.green.bold("ENVIRONMENT STATUS: READY") : "ENVIRONMENT STATUS: READY")
	} else {
		lines.push(colored ? chalk.red.bold("ENVIRONMENT STATUS: NOT READY") : "ENVIRONMENT STATUS: NOT READY")
	}

	// Individual checks
	for (const check of result.checks) {
		const icon = check.ok ? "✓" : "✗"
		const line = `  ${icon} ${check.name}: ${check.message}`
		if (colored) {
			lines.push(check.ok ? chalk.green(line) : chalk.red(line))
		} else {
			lines.push(line)
		}
	}

	return lines.join("\n")
}

/**
 * Run preflight check mode: print status and exit
 * Exit code 0 if all checks pass, 1 if any fail
 */
export function runPreflightCheck(result: PreflightResult): never {
	console.log(formatPreflightStatus(result, true))
	process.exit(result.ok ? 0 : 1)
}

/**
 * Exit with error if preflight checks failed
 * Call this at the start of action handlers that require the environment
 */
export function exitOnPreflightFailure(result: PreflightResult): void {
	if (result.ok) return

	console.error(formatPreflightStatus(result, true))
	console.error()
	console.error(chalk.dim("Run with --help to see requirements"))
	process.exit(1)
}

/**
 * Add preflight check option to a Commander program
 * Must be called after addCommonOptions
 */
export function addPreflightOption(program: Command): Command {
	return program.option(
		"--preflight-check",
		"Check environment requirements and exit (0=ready, 1=not ready)"
	)
}

/**
 * Handle --preflight-check if specified in options
 * Call this at the very start of action handlers, before any other logic
 */
export function handlePreflightOption(options: { preflightCheck?: boolean }, result: PreflightResult): void {
	if (options.preflightCheck) {
		runPreflightCheck(result)
	}
}
