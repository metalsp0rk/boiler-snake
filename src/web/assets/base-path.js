/**
 * Shoelace resolves icons by fetch from this prefix. It must run before any
 * component module evaluates: those modules upgrade elements already in the
 * DOM, and a late setBasePath sends the first icon fetch to the CDN.
 * Import this module first from forge.js.
 *
 * Pinned with the bundle: @shoelace-style/shoelace@2.20.1 (MIT), self-hosted.
 * No CDN. The CSP build is Lit's adoptedStyleSheets (no shadow <style>).
 */
import { setBasePath } from "@shoelace-style/shoelace/dist/utilities/base-path.js";
import { registerIconLibrary } from "@shoelace-style/shoelace/dist/utilities/icon-library.js";

setBasePath("/static/forge/");

// Shoelace's built-in "system" library resolves to data: SVG URLs and then
// fetch()es them. fetch(data:) is connect-src, which the console CSP does
// not allow (default-src 'self' only). The same icons already exist as files
// under the base path, so point the system library at those.
registerIconLibrary("system", {
  resolver: (name) => `/static/forge/assets/icons/${name}.svg`,
});
