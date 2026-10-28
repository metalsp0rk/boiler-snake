/**
 * Forged Instrument entry (#710). Pages that have not migrated keep loading
 * /static/app.js. This module is the new shell's script: tokens, Shoelace's
 * CSP build (adoptedStyleSheets), and the custom primitives.
 *
 * Component list is the #709 vocabulary. Adding one requires an amendment
 * on that issue.
 */
import "./base-path.js";
import "@shoelace-style/shoelace/dist/themes/dark.css";
import "./fonts.css";
import "./tokens.css";
import "./primitives.css";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/input/input.js";
import "@shoelace-style/shoelace/dist/components/select/select.js";
import "@shoelace-style/shoelace/dist/components/option/option.js";
import "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import "@shoelace-style/shoelace/dist/components/badge/badge.js";
import "@shoelace-style/shoelace/dist/components/tag/tag.js";
import "@shoelace-style/shoelace/dist/components/tab-group/tab-group.js";
import "@shoelace-style/shoelace/dist/components/tab/tab.js";
import "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js";
import "@shoelace-style/shoelace/dist/components/details/details.js";
import "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import "@shoelace-style/shoelace/dist/components/alert/alert.js";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";
import "@shoelace-style/shoelace/dist/components/copy-button/copy-button.js";
import "@shoelace-style/shoelace/dist/components/progress-bar/progress-bar.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";
import { installLookupCombobox } from "./lookup-install.js";
import { installUserCard } from "./user-card-install.js";

function boot() {
  installLookupCombobox(document);
  installUserCard(document);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
