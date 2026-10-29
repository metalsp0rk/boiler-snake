/**
 * Forged Instrument entry (#710). The signed-in shell also loads
 * /static/app.js. This module is the shell script: page-body CSS, Shoelace's
 * CSP build (adoptedStyleSheets), and the custom primitives. The sign-in
 * landing links the CSS this module emits and does not load the module.
 *
 * Component list is the #709 vocabulary. Adding one requires an amendment
 * on that issue.
 */
import "./base-path.js";
import "./page.css";
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
  // The signed-in shell also loads /static/app.js, which installs lookup,
  // user cards, the Menu toggle, and charts. A second install would
  // double-bind those listeners. Fixtures that load only this module
  // still get the installers.
  if (document.querySelector('script[src*="/static/app.js"]')) return;
  installLookupCombobox(document);
  installUserCard(document);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
