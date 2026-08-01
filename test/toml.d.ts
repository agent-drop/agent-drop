// Bun imports `.toml` natively, so the suite can read the committed
// wrangler.toml as data rather than shipping a TOML parser just for tests.
// TypeScript has no built-in knowledge of the loader, hence this declaration.
declare module "*.toml" {
	const value: Record<string, unknown>;
	export default value;
}
