/**
 * Archive-index table SHAPE (#408, audit C2-4): the People column was
 * added to the ROWS ("<td class=\"people\">" — creator + owner) without a
 * matching <th> — every column from the 3rd onward rendered under the
 * wrong header on BOTH archive surfaces (/t and /g/:guildId/t), and the
 * empty state's colspan="7" silently admitted the lie. The fix is one
 * <th>; THIS is the lock: header count == row cell count, in the right
 * order, with the empty state agreeing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { renderTicketIndexContent } = require("../src/web/views/tickets/indexPage");

const TICKET = {
  transcript_token: "tok-408",
  ticket_number: 7,
  community_id: 42,
  creator_user_id: "111111111111111111",
  staff_owner_id: "222222222222222222",
  closed_at: 1730000000000,
  reason: "staff notes demo",
  ai_summary_json: null,
  close_reason: "resolved by policy",
};

function render(over = {}) {
  return renderTicketIndexContent({
    tickets: [TICKET],
    total: 1,
    page: 1,
    pageSize: 20,
    guildId: null,
    inShell: false,
    viewerMode: "staff",
    ...over,
  });
}

test("the archive index declares as many headers as its rows emit cells (#408)", () => {
  const out = render();
  const heads = out.match(/<th>([^<]*)<\/th>/g) ?? [];
  assert.equal(heads.length, 7, "the People <th> exists — the header row finally matches the row builder");

  const texts = heads.map((h) => h.replace(/<[^>]+>/g, ""));
  assert.deepEqual(
    texts.slice(0, 4),
    ["Ticket", "Guild", "People", "Closed"],
    "People sits between Guild and Closed — the position its <td> occupies",
  );

  const body = out.slice(out.indexOf("<tbody"));
  const firstRow = body.slice(0, body.indexOf("</tr>"));
  assert.equal(
    (firstRow.match(/<td/g) ?? []).length,
    heads.length,
    "row cells and headers agree — no column renders under a wrong label",
  );
  assert.match(firstRow, /class="people"/, "the People cell is the 3rd one");
});

test("the empty state's colspan equals the header count (#408)", () => {
  const out = render({ tickets: [], total: 0 });
  const headCount = (out.match(/<th>([^<]*)<\/th>/g) ?? []).length;
  const colspan = out.match(/colspan="(\d+)"/);
  assert.ok(colspan, "the empty row spans the table");
  assert.equal(
    Number(colspan[1]),
    headCount,
    "colspan and the header count stay one fact — drift here is what hid the missing People header",
  );
});
