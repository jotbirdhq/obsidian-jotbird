import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["src/**/*.test.ts", "src/__mocks__/**"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
		rules: {
			// "Pro" is the JotBird subscription tier (a proper noun), not a
			// mis-capitalized word.
			"obsidianmd/ui/sentence-case": [
				"error",
				{ ignoreWords: ["JotBird", "Pro"] },
			],
		},
	},
]);
