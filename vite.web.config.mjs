/**
 * Vite asset build for the Forged Instrument console (#710).
 * Express keeps every server responsibility; this config only emits the
 * self-hosted bundle under dist/web, served at /static/forge/*.
 *
 * `assets:dev` uses base `/` so the preview page is http://localhost:5173/dev.html.
 * Icon SVGs are not bundled — Shoelace fetches them from setBasePath — so the
 * dev server mounts the package's assets directory at /static/forge/assets.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const shoelaceAssets = path.join(
  root,
  "node_modules/@shoelace-style/shoelace/dist/assets"
);

const CONTENT_TYPES = {
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

function shoelaceDevAssets() {
  return {
    name: "shoelace-dev-assets",
    configureServer(server) {
      server.middlewares.use("/static/forge/assets", (req, res, next) => {
        const rel = decodeURIComponent(String(req.url || "").split("?")[0]).replace(
          /^\/+/,
          ""
        );
        if (!rel || rel.includes("..") || rel.split("/").some((seg) => seg.startsWith("."))) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const abs = path.resolve(shoelaceAssets, rel);
        const base = path.resolve(shoelaceAssets);
        if (abs !== base && !abs.startsWith(base + path.sep)) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          next();
          return;
        }
        const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream";
        res.setHeader("Content-Type", type);
        createReadStream(abs).pipe(res);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/static/forge/" : "/",
  publicDir: false,
  plugins: [shoelaceDevAssets()],
  server: {
    port: 5173,
    open: "/src/web/assets/dev.html",
  },
  build: {
    outDir: path.join(root, "dist/web"),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    cssCodeSplit: false,
    // data: URLs are blocked by default-src 'self' (font-src is not loosened).
    assetsInlineLimit: 0,
    rollupOptions: {
      input: path.join(root, "src/web/assets/forge.js"),
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/forge-[hash].js",
        chunkFileNames: "assets/forge-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
