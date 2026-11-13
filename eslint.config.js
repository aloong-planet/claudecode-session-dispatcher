import { join } from "node:path";
import js from "@eslint/js";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  includeIgnoreFile(join(import.meta.dirname, ".gitignore"), { gitignoreResolution: true }),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  // Claude Code writes a tsconfig of its own into the plugin's directory when it loads the mod. The mod is checked
  // against this repository's tsconfig whether that file is there or not.
  { files: ["plugin/**/*.ts"], languageOptions: { parserOptions: { projectService: false, project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname } } },
  // This file belongs to no tsconfig, so it has no type information.
  { files: ["eslint.config.js"], extends: [tseslint.configs.disableTypeChecked] },
);
