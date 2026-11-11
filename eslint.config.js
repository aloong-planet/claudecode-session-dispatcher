import { join } from "node:path";
import js from "@eslint/js";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  includeIgnoreFile(join(import.meta.dirname, ".gitignore"), { gitignoreResolution: true }),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  // This file belongs to no tsconfig, so it has no type information.
  { files: ["eslint.config.js"], extends: [tseslint.configs.disableTypeChecked] },
);
