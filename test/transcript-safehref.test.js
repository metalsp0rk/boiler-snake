/**
 * #466 (C2-2): stored transcript attachment hrefs are member-influenced
 * (close.js persists a.url || a.proxyURL). Both renderers — the frozen
 * archive page and the live staff console — escaped these values but never
 * asked about the SCHEME: a poisoned transcript could plant
 * `javascript:`/data/phishing links into the staff browser (§41 trust
 * boundary: render-time validation at the HTML boundary; CSP was catching
 * the worst of it, a clickable phishing <a href> always got through).
 * One safeHref() rule now gates BOTH renderers.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const { safeHref } = require("../src/core/safeHref");
const archive = require("../src/features/tickets/transcript");
const consoleView = require("../src/web/views/transcripts/transcriptPage");

after(cleanup);

describe("#466 (C2-2): safeHref — the render-boundary scheme gate", () => {
  it("accepts http(s) and app-relative assets", () => {
    assert.equal(safeHref("https://cdn.example.test/a.png"), "https://cdn.example.test/a.png");
    assert.equal(safeHref("http://cdn.example.test/a.png"), "http://cdn.example.test/a.png");
    assert.equal(safeHref("HTTPS://CDN.EXAMPLE/A"), "HTTPS://CDN.EXAMPLE/A", "scheme case is not a verdict");
    assert.equal(safeHref("assets/42/a.png"), "assets/42/a.png");
    assert.equal(safeHref("/assets/42/a.png"), "/assets/42/a.png");
    assert.equal(
      safeHref("/t/tok123/assets/001_photo.png"),
      "/t/tok123/assets/001_photo.png",
      "the transcript route's own asset paths are the archive's local media (spec pin)",
    );
  });

  it("refuses every non-renderable scheme and shape", () => {
    for (const evil of [
      "javascript:alert(1)",
      "  javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox",
      "//evil.test/x.png",
      "///evil.test/x.png",
      "/t/tok/assets/../../x",
      "/spaced path.png",
      "file:///etc/passwd",
      "",
      "   ",
      null,
      42,
      { href: "https://ok" },
    ]) {
      assert.equal(safeHref(evil), null, `must refuse: ${JSON.stringify(evil)}`);
    }
  });
});

describe("#466 (C2-2): both transcript renderers drop poisoned hrefs to plain text", () => {
  const evil = { name: "x.png", href: "javascript:alert(1)", kind: "image" };
  const good = { name: "ok.png", href: "https://cdn.example.test/ok.png", kind: "image" };

  it("frozen archive builder: no javascript href survives, the honest https one rides", () => {
    const html = archive.renderAttachmentsHtml([evil, good]);
    assert.ok(!/href="javascript/i.test(html), `javascript: href reached the archive page: ${html}`);
    assert.ok(!/src="javascript/i.test(html), "same for img src");
    assert.match(html, /\(link scheme blocked\)/, "the refusal is stated, not silently dropped");
    assert.ok(html.includes("x.png"), "the name survives as text");
    assert.ok(html.includes('href="https://cdn.example.test/ok.png"'), "safe attachments are untouched");
  });

  it("live console page: same gate, same copy", () => {
    const html = String(
      consoleView.renderAttachments({
        attachment_urls: JSON.stringify([evil, good]),
      }),
    );
    assert.ok(!/href="javascript/i.test(html), `javascript: href reached the console page: ${html}`);
    assert.match(html, /link scheme blocked/);
    assert.ok(html.includes("https://cdn.example.test/ok.png"), "safe attachments untouched");
  });
});
