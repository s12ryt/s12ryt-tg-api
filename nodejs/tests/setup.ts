/**
 * Global test setup — runs before each test file is loaded.
 *
 * Provides default environment variables so that modules with top-level
 * side-effects (e.g. src/config.ts calling requireEnv("BOT_TOKEN"))
 * can be imported without a real .env file (e.g. in CI).
 *
 * Uses ??= so existing values are never overwritten.
 * Tests that need to control these values (e.g. config.test.ts) use
 * vi.resetModules() + manual env manipulation, so they are unaffected.
 */

process.env.BOT_TOKEN ??= "test-bot-token";
process.env.ADMIN_ID ??= "123456789";
