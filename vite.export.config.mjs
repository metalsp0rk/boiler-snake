/**
 * Self-contained transcript export CSS (#713).
 *
 * Separate from the console bundle: that one keeps font files as real URLs
 * because the console CSP blocks data: fonts. This build inlines the same
 * woff2 files so an archived HTML file opens offline with no /static request.
 * `assets:build` runs it after the console build and does not empty dist/web.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: path.join(root, "dist/web"),
    emptyOutDir: false,
    manifest: false,
    sourcemap: false,
    cssCodeSplit: false,
    // Console CSP forbids data: fonts. This file is inlined into an export
    // that is allowed font-src data: and must not point at /static.
    assetsInlineLimit: 10 * 1024 * 1024,
    rollupOptions: {
      input: path.join(root, "src/web/assets/transcript-export.js"),
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/transcript-export.js",
        assetFileNames: "transcript-export.css",
      },
    },
  },
});
