/**
 * #466 (C2-5): the archive pager/filter href builder must URL-ENCODE the
 * search term — HTML-escaping alone re-emitted `&`/`=`/`+` raw, so clicking
 * prev/next after searching "fix & run" silently changed the search
 * (q=fix& + junk). The server auto-decodes on read, so the round trip is
 * exact once the value is encoded.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const { renderTicketIndexContent } = require("../src/web/views/tickets/indexPage");

after(cleanup);

describe("#466 (C2-5): pager keeps query VALUES encoded", () => {
  const render = (q, page = 2) =>
    String(
      renderTicketIndexContent({
        tickets: [],
        total: 50,
        page,
        pageSize: 10,
        q,
        guildId: null,
      }),
    );

  it("a search term with & = + is percent-encoded in every pager link", () => {
    const html = render("fix & run=1+2");
    assert.ok(
      html.includes("q=fix%20%26%20run%3D1%2B2"),
      `encoded value rides the pager: ${html.match(/href="[^"]*q=[^"]*"/)?.[0] ?? "no q href"}`,
    );
    assert.ok(
      !/q=fix &/.test(html) && !/q=fix &amp;/.test(html),
      "raw or merely-escaped ampersands would re-split the query on click",
    );
  });

  it("plain terms are byte-identical after encoding (no double-encoding, no churn)", () => {
    const html = render("docket-42");
    assert.ok(html.includes("q=docket-42"), "safe terms keep their bytes");
  });

  it("the guild filter is encoded too (no-op for vetted integers, honest for anything else)", () => {
    const html = String(
      renderTicketIndexContent({
        tickets: [],
        total: 50,
        page: 2,
        pageSize: 10,
        guildId: 7,
      }),
    );
    assert.ok(html.includes("guild=7"));
    assert.ok(
      /href="[^"]*guild=7&page=3"/.test(html),
      "next-page link: guild segment, literal & separator, page segment"
    );
  });
});
