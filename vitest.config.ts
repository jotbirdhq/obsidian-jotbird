import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, "src/__mocks__/obsidian.ts"),
		},
	},
	test: {
		globals: true,
		include: ["src/**/*.test.ts"],
		// Provides `window` (the plugin must use window.* timers — see the file).
		setupFiles: ["src/__mocks__/testSetup.ts"],
	},
});
