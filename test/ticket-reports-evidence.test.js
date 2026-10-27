/**
 * Evidence builder unit tests (#745 subtask 07, locked decisions 4/13/15).
 *
 * Fully offline: every attachment URL is served by an injected `fetchImpl`
 * + `resolveHost` pair (the SSRF guard's own seams — no sockets, no DNS,
 * no timers that outlive a test). The guard runs FOR REAL around the stub,
 * so https-only + address checks + the maxBytes enforcement (both the
 * content-length pre-check and the post-read byte cap) are exercised too.
 *
 * Pinned behaviors: the ok:false structural contract with specific errors
 * (rule 6), exact decision-13 disposition strings, the header field set
 * with tsFull timestamps and jump links, mention inertness (a planted
 * <@123>/@everyone can never live in non-fenced text), the >chunk content
 * split, the .txt-file fallback (both triggers), image inlining with
 * byte-exact attachment:// names, filename sanitization + collision
 * suffixes, and the rule-5 accumulation where one bad file never sinks
 * the evidence post.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// #609 CONTRACT: fresh DB before any src/ require — reportEvidence's graph
// (assets/ssrfGuard chain) reaches the db layer, so the binder must precede it.
const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb();
after(cleanup);

const {
  buildEvidenceMessage,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_CHUNK_CHARS,
  EVIDENCE_MAX_EMBEDS,
} = require("../src/features/tickets/reportEvidence");

/** Forced instant: every timestamp in this file derives from it. */
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);

/** Message-variant snapshot exactly as pendingReports.take() returns it. */
function snapshot(overrides = {}) {
  return {
    kind: "message",
    guildId: "1000",
    reporterUserId: "2000",
    messageId: "3000",
    channelId: "4000",
    channelName: "general",
    authorId: "5000",
    content: "read the rules or else",
    attachments: [],
    embedUrls: [],
    stickers: [],
    subjectUserId: "5000",
    capturedAt: T0,
    ...overrides,
  };
}

const JUMP = "https://discord.com/channels/1000/4000/3000";

// ---------- fetch / DNS seams (no network, no real DNS) ----------

const PUBLIC_IPS = ["93.184.216.34"];
const resolvePublic = async () => PUBLIC_IPS;

/**
 * Response-lite the SSRF guard understands (no `body` stream → the guard's
 * buffered arrayBuffer path, whose post-read byte cap we also exercise).
 */
function okResponse(bytes, { contentType = null, contentLength = null } = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const n = String(name).toLowerCase();
        if (n === "content-type") return contentType;
        if (n === "content-length") return contentLength;
        return null;
      },
    },
    async arrayBuffer() {
      return bytes;
    },
  };
}

function notFound() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    async arrayBuffer() {
      return Buffer.alloc(0);
    },
  };
}

/**
 * fetchImpl stub: `routes` maps url → response | Error (thrown). Unknown
 * urls answer 404. `calls` records every attempted URL (pre-skip proofs).
 */
function makeFetch(routes = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route instanceof Error) throw route;
    return route ?? notFound();
  };
  impl.calls = calls;
  return impl;
}

function att(overrides = {}) {
  return {
    id: "700",
    name: "proof.png",
    url: "https://cdn.example/proof.png",
    size: 8,
    contentType: "image/png",
    ...overrides,
  };
}

// ---------- embed inspection helpers ----------

function raw(embeds) {
  return embeds.map((e) => e.toJSON());
}

function allText(embeds) {
  return raw(embeds)
    .map((j) =>
      [
        j.title,
        j.description,
        j.footer?.text,
        ...(j.fields || []).flatMap((f) => [f.name, f.value]),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function fieldValue(embeds, name) {
  for (const j of raw(embeds)) {
    const field = (j.fields || []).find((f) => f.name === name);
    if (field) return field.value;
  }
  return null;
}

function textEmbeds(embeds, titlePrefix) {
  return raw(embeds).filter(
    (j) => typeof j.title === "string" && j.title.startsWith(titlePrefix),
  );
}

/** The chunk inside a `fence\nchunk\nfence` description (fence = longest run). */
function fenceBody(description) {
  const m = /^(`{3,})\n([\s\S]*)\n\1$/m.exec(description);
  assert.ok(m, "description must be a fenced code block");
  return m[2];
}

/** Remove fenced-code regions: what remains must be live-markdown-safe. */
function stripFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (fence) {
      if (trimmed === fence) fence = null;
      continue;
    }
    const open = /^(`{3,})/.exec(trimmed);
    if (open) {
      fence = open[1];
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Live (unescaped, unfenced) occurrences of `token` in `text`. */
function liveMentions(text, token) {
  const stripped = stripFences(text);
  let count = 0;
  let at = -1;
  while ((at = stripped.indexOf(token, at + 1)) !== -1) {
    if (at === 0 || stripped[at - 1] !== "\\") count += 1;
  }
  return count;
}

// ---------- structural contract ----------

describe("reportEvidence structural contract (rule 6: ok:false, never throws)", () => {
  it("rejects a missing snapshot with a specific error", async () => {
    const res = await buildEvidenceMessage(null);
    assert.equal(res.ok, false);
    assert.equal(res.error, "Evidence snapshot is missing or not an object");
  });

  it("rejects a non-message snapshot", async () => {
    const res = await buildEvidenceMessage(snapshot({ kind: "user" }));
    assert.equal(res.ok, false);
    assert.match(res.error, /not a message report/);
  });

  it("rejects a snapshot without a reporter, with the specific error", async () => {
    const res = await buildEvidenceMessage(snapshot({ reporterUserId: null }));
    assert.equal(res.ok, false);
    assert.equal(res.error, "Evidence snapshot is missing its reporter user id");
  });

  it("rejects a snapshot without message / channel / guild ids", async () => {
    const noMessage = await buildEvidenceMessage(snapshot({ messageId: null }));
    assert.equal(noMessage.ok, false);
    assert.match(noMessage.error, /missing its message id/);

    const noChannel = await buildEvidenceMessage(snapshot({ channelId: null }));
    assert.equal(noChannel.ok, false);
    assert.match(noChannel.error, /missing its source channel id/);

    const noGuild = await buildEvidenceMessage(snapshot({ guildId: null }));
    assert.equal(noGuild.ok, false);
    assert.match(noGuild.error, /missing its guild id/);
  });

  it("prefers opts.reporterUserId over the snapshot (the real submitter wins)", async () => {
    const res = await buildEvidenceMessage(snapshot({ reporterUserId: null }), {
      reporterUserId: "2222",
      deleted: true,
    });
    assert.equal(res.ok, true);
    assert.equal(fieldValue(res.embeds, "Reported by"), "<@2222>");
    assert.equal(
      fieldValue(res.embeds, "Disposition"),
      "Original message deleted by <@2222> via this ticket",
    );
  });
});

// ---------- header, metadata lines, disposition ----------

describe("reportEvidence header embed + decision-13 disposition", () => {
  it("renders reporter, author, message id, source channel and jump link", async () => {
    const res = await buildEvidenceMessage(snapshot());
    assert.equal(res.ok, true);
    assert.equal(fieldValue(res.embeds, "Reported by"), "<@2000>");
    assert.equal(fieldValue(res.embeds, "Message author"), "<@5000>");
    assert.equal(fieldValue(res.embeds, "Message ID"), "3000");
    const channel = fieldValue(res.embeds, "Source channel");
    assert.ok(channel.includes("\\#general"), `escaped name in: ${channel}`);
    assert.ok(channel.includes(JUMP), `jump link in: ${channel}`);
  });

  it("shows the capture timestamp with the open-notice tsFull convention", async () => {
    const res = await buildEvidenceMessage(snapshot());
    assert.equal(
      fieldValue(res.embeds, "Reported"),
      `<t:${Math.floor(T0 / 1000)}:F>`,
    );
  });

  it("renders the exact deleted-disposition string", async () => {
    const res = await buildEvidenceMessage(snapshot(), { deleted: true });
    assert.equal(
      fieldValue(res.embeds, "Disposition"),
      "Original message deleted by <@2000> via this ticket",
    );
  });

  it("renders the exact kept-disposition string with the jump URL", async () => {
    const res = await buildEvidenceMessage(snapshot(), { deleted: false });
    assert.equal(
      fieldValue(res.embeds, "Disposition"),
      `Original kept: ${JUMP}`,
    );
  });

  it("records original embed URLs and stickers as escaped text metadata", async () => {
    const res = await buildEvidenceMessage(
      snapshot({
        embedUrls: ["https://ex.example/post?a=1", "<@123>"],
        stickers: ["Pepe Wing", "<@&999>"],
      }),
    );
    const desc = raw(res.embeds)[0].description;
    assert.ok(desc.includes("**Original embed URLs:**"));
    assert.ok(desc.includes("https://ex.example/post?a=1"));
    // The contract is inertness + visibility, not one exact escape shape:
    // no live <@id> token may survive, and the id must still be readable.
    assert.ok(!desc.includes("<@123>"), `live mention survived: ${desc}`);
    assert.ok(desc.includes("123"), "escaped planted mention still visible");
    assert.ok(desc.includes("**Original stickers:**"));
    assert.ok(desc.includes("Pepe Wing"));
    assert.ok(!desc.includes("<@&999>"), "live role mention survived");
    assert.ok(desc.includes("999"), "escaped planted role mention visible");
  });

  it("shows '(no text content)' for an empty message", async () => {
    const res = await buildEvidenceMessage(snapshot({ content: "" }));
    assert.ok(allText(res.embeds).includes("(no text content)"));
    assert.equal(textEmbeds(res.embeds, "Reported message content").length, 0);
  });
});

// ---------- mention inertness (the ping guarantee) ----------

describe("reportEvidence mention inertness", () => {
  const PLANTED = ["<@123", "<@!123", "<@&999", "@everyone"];

  it("makes planted mentions in content, context, channel and stickers inert", async () => {
    const res = await buildEvidenceMessage(
      snapshot({
        content: "hey <@123> look <@!123> at <@&999> @everyone now",
        channelName: "<@123>-chat",
        stickers: ["<@&999>"],
      }),
      { contextText: "please moderate <@123> @everyone thanks" },
    );
    assert.equal(res.ok, true);
    const text = allText(res.embeds);
    for (const token of PLANTED) {
      assert.equal(
        liveMentions(text, token),
        0,
        `token ${token} must never appear live outside a code fence`,
      );
    }
  });

  it("keeps the raw evidence bytes VISIBLE inside fenced content", async () => {
    const res = await buildEvidenceMessage(
      snapshot({ content: "hey <@123> @everyone" }),
      { contextText: "mod <@123>" },
    );
    const content = textEmbeds(res.embeds, "Reported message content")[0];
    assert.equal(fenceBody(content.description), "hey <@123> @everyone");
    const context = textEmbeds(res.embeds, "Reporter context")[0];
    assert.equal(fenceBody(context.description), "mod <@123>");
  });

  it("grows the fence past backtick runs so content cannot escape it", async () => {
    const tricky = "escape attempt ``` <@123> ```` done";
    const res = await buildEvidenceMessage(snapshot({ content: tricky }));
    const content = textEmbeds(res.embeds, "Reported message content")[0];
    assert.ok(content.description.startsWith("`````")); // 5 = longest run(4)+1
    assert.equal(fenceBody(content.description), tricky);
    assert.equal(liveMentions(allText(res.embeds), "<@123"), 0);
  });
});

// ---------- content split + .txt fallback ----------

describe("reportEvidence content rendering and fallback", () => {
  it("splits content above the chunk budget and preserves every character", async () => {
    const long = "ab".repeat((EVIDENCE_CHUNK_CHARS * 1.2) / 2); // ~20% over one chunk
    assert.ok(long.length > EVIDENCE_CHUNK_CHARS);
    const res = await buildEvidenceMessage(snapshot({ content: long }));
    assert.equal(res.ok, true);

    const parts = textEmbeds(res.embeds, "Reported message content");
    assert.equal(parts.length, 2);
    assert.equal(parts[0].title, "Reported message content (1/2)");
    assert.equal(parts[1].title, "Reported message content (2/2)");
    assert.equal(parts.map((p) => fenceBody(p.description)).join(""), long);
  });

  it("attaches pathological content as a .txt file part (embed-count trigger)", async () => {
    const huge = "x".repeat(EVIDENCE_CHUNK_CHARS * 26);
    const res = await buildEvidenceMessage(snapshot({ content: huge }));
    assert.equal(res.ok, true);

    assert.equal(textEmbeds(res.embeds, "Reported message content").length, 0);
    const txt = res.files.find((f) => f.name === "report-content-3000.txt");
    assert.ok(txt, `content .txt missing from ${res.files.map((f) => f.name)}`);
    assert.equal(txt.attachment.toString("utf8"), huge);
    assert.ok(allText(res.embeds).includes("report-content-3000.txt"));
  });

  it("falls back to .txt when the aggregate embed budget is exceeded", async () => {
    // 3 parts — under the 10-embed cap, far over the 6000-char aggregate.
    const big = "z".repeat(EVIDENCE_CHUNK_CHARS * 2 + 500);
    const res = await buildEvidenceMessage(snapshot({ content: big }));
    assert.equal(res.ok, true);
    assert.equal(textEmbeds(res.embeds, "Reported message content").length, 0);
    const txt = res.files.find((f) => f.name === "report-content-3000.txt");
    assert.ok(txt, "aggregate-overflow content must ship as a .txt part");
    assert.equal(txt.attachment.toString("utf8"), big);
  });

  it("keeps the whole embed set inside Discord's caps", async () => {
    const res = await buildEvidenceMessage(
      snapshot({
        content: "cd".repeat(1500), // 3000 chars, one part
        stickers: ["One", "Two"],
        embedUrls: ["https://a.example/1", "https://b.example/2"],
      }),
      { contextText: "x".repeat(300), deleted: false },
    );
    assert.equal(res.ok, true);
    assert.ok(res.embeds.length <= EVIDENCE_MAX_EMBEDS);
    const total = raw(res.embeds).reduce(
      (n, j) =>
        n +
        (j.title?.length || 0) +
        (j.description?.length || 0) +
        (j.footer?.text?.length || 0) +
        (j.fields || []).reduce((m, f) => m + f.name.length + f.value.length, 0),
      0,
    );
    assert.ok(total <= 6000, `aggregate embed chars ${total}`);
  });
});

// ---------- attachment re-upload pipeline ----------

describe("reportEvidence attachment pipeline (decision 4 + error rule 5)", () => {
  it("inlines a fetched image with a byte-exact attachment:// reference", async () => {
    const bytes = Buffer.from("PNGBYTES");
    const fetchImpl = makeFetch({
      "https://cdn.example/proof.png": okResponse(bytes, {
        contentType: "image/png",
      }),
    });
    const res = await buildEvidenceMessage(snapshot({ attachments: [att()] }), {
      fetchImpl,
      resolveHost: resolvePublic,
    });

    assert.equal(res.ok, true);
    assert.equal(res.files.length, 1);
    assert.ok(Buffer.isBuffer(res.files[0].attachment));
    assert.equal(res.files[0].name, "proof.png");
    assert.deepEqual([...res.files[0].attachment], [...bytes]);

    const ref = raw(res.embeds)
      .map((j) => j.image?.url)
      .find(Boolean);
    assert.ok(ref, "an inline image embed must exist");
    assert.equal(ref, `attachment://${res.files[0].name}`);
  });

  it("sanitizes attachment names and keeps the reference identical", async () => {
    const fetchImpl = makeFetch({
      "https://cdn.example/x": okResponse(Buffer.from("ii"), {
        contentType: "image/png",
      }),
    });
    const res = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({ name: "my photo/../x.png", url: "https://cdn.example/x" }),
        ],
      }),
      { fetchImpl, resolveHost: resolvePublic },
    );
    assert.equal(res.ok, true);
    assert.equal(res.files[0].name, "x.png");
    const ref = raw(res.embeds)
      .map((j) => j.image?.url)
      .find(Boolean);
    assert.equal(ref, "attachment://x.png");
  });

  it("resolves same-name collisions with -2 suffixes (refs stay exact)", async () => {
    const fetchImpl = makeFetch({
      "https://cdn.example/a.png": okResponse(Buffer.from("AAA"), {
        contentType: "image/png",
      }),
      "https://cdn.example/b.png": okResponse(Buffer.from("BBB"), {
        contentType: "image/png",
      }),
    });
    const res = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({ name: "photo.png", url: "https://cdn.example/a.png" }),
          att({ name: "photo.png", url: "https://cdn.example/b.png" }),
        ],
      }),
      { fetchImpl, resolveHost: resolvePublic },
    );

    assert.equal(res.ok, true);
    const names = res.files.map((f) => f.name).sort();
    assert.deepEqual(names, ["photo-2.png", "photo.png"]);

    const refs = raw(res.embeds)
      .map((j) => j.image?.url)
      .filter(Boolean)
      .sort();
    assert.deepEqual(refs, [
      "attachment://photo-2.png",
      "attachment://photo.png",
    ]);
    // every reference names an actual file, byte-for-byte
    for (const ref of refs) {
      const wanted = ref.slice("attachment://".length);
      assert.ok(
        res.files.some((f) => f.name === wanted),
        `reference ${ref} has no matching file`,
      );
    }
  });

  it("ships video and documents as playable files without inlining", async () => {
    const fetchImpl = makeFetch({
      "https://cdn.example/clip.mp4": okResponse(Buffer.from("VID"), {
        contentType: "video/mp4",
      }),
      "https://cdn.example/doc.pdf": okResponse(Buffer.from("PDF"), {
        contentType: "application/pdf",
      }),
    });
    const res = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({ name: "clip.mp4", url: "https://cdn.example/clip.mp4", contentType: "video/mp4" }),
          att({ name: "doc.pdf", url: "https://cdn.example/doc.pdf", contentType: "application/pdf" }),
        ],
      }),
      { fetchImpl, resolveHost: resolvePublic },
    );

    assert.equal(res.ok, true);
    assert.deepEqual(res.files.map((f) => f.name).sort(), ["clip.mp4", "doc.pdf"]);
    const text = allText(res.embeds);
    assert.ok(!text.includes("clip.mp4"), "no inline embed for video");
    assert.ok(!text.includes("doc.pdf"), "no inline embed for the pdf");
  });

  it("skips the download for a declared-oversized file and warns with the phrase", async () => {
    const fetchImpl = makeFetch({});
    const res = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({
            name: "big.zip",
            url: "https://cdn.example/big.zip",
            size: EVIDENCE_MAX_BYTES + 1,
            contentType: null,
          }),
        ],
      }),
      { fetchImpl, resolveHost: resolvePublic },
    );

    assert.equal(res.ok, true);
    assert.equal(res.files.length, 0);
    assert.equal(fetchImpl.calls.length, 0, "must not fetch what it will refuse");
    assert.equal(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("big.zip"));
    assert.ok(res.warnings[0].includes("may not survive deletion"));
    assert.ok(res.warnings[0].includes("declared"), "names the declared size");
  });

  it("honours the maxBytesPerFile override on both content-length and bytes", async () => {
    const byLength = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({ name: "long.png", url: "https://cdn.example/long", size: null }),
        ],
      }),
      {
        maxBytesPerFile: 64,
        resolveHost: resolvePublic,
        fetchImpl: makeFetch({
          "https://cdn.example/long": okResponse(Buffer.alloc(4), {
            contentLength: "99999",
            contentType: "image/png",
          }),
        }),
      },
    );
    assert.equal(byLength.ok, true);
    assert.equal(byLength.files.length, 0);
    assert.match(byLength.warnings[0], /long\.png/);
    assert.match(byLength.warnings[0], /99999/);
    assert.ok(byLength.warnings[0].includes("may not survive deletion"));

    const byBytes = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({ name: "liar.gif", url: "https://cdn.example/liar", size: null }),
        ],
      }),
      {
        maxBytesPerFile: 64,
        resolveHost: resolvePublic,
        fetchImpl: makeFetch({
          "https://cdn.example/liar": okResponse(Buffer.alloc(200), {
            contentType: "image/gif",
          }),
        }),
      },
    );
    assert.equal(byBytes.ok, true);
    assert.equal(byBytes.files.length, 0);
    assert.match(byBytes.warnings[0], /liar\.gif/);
    assert.ok(byBytes.warnings[0].includes("may not survive deletion"));
  });

  it("defaults to EVIDENCE_MAX_BYTES = 10 MiB", async () => {
    assert.equal(EVIDENCE_MAX_BYTES, 10 * 1024 * 1024);
    const res = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({
            name: "huge.png",
            url: "https://cdn.example/huge",
            size: 11 * 1024 * 1024,
            contentType: "image/png",
          }),
        ],
      }),
      { resolveHost: resolvePublic, fetchImpl: makeFetch({}) },
    );
    assert.match(res.warnings[0], /10 MiB/);
  });

  it("turns a rejected fetch into a warning without touching other files", async () => {
    const fetchImpl = makeFetch({
      "https://cdn.example/good.png": okResponse(Buffer.from("GOOD"), {
        contentType: "image/png",
      }),
      "https://cdn.example/bad.gif": Error("socket exploded"),
    });
    const res = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({ name: "good.png", url: "https://cdn.example/good.png" }),
          att({
            name: "bad.gif",
            url: "https://cdn.example/bad.gif",
            contentType: "image/gif",
          }),
        ],
      }),
      { fetchImpl, resolveHost: resolvePublic },
    );

    assert.equal(res.ok, true); // rule 5: one bad file never aborts the post
    assert.deepEqual(res.files.map((f) => f.name), ["good.png"]);
    assert.equal(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("bad.gif"));
    assert.ok(res.warnings[0].includes("socket exploded"), "carries the cause");
    assert.ok(res.warnings[0].includes("may not survive deletion"));
    // ...and the metadata-only evidence line is IN the embed set
    assert.ok(allText(res.embeds).includes("**Files not recovered (metadata only):**"));
    assert.ok(allText(res.embeds).includes("may not survive deletion"));
  });

  it("warns on HTTP failures and on snapshots without a URL", async () => {
    const missing = await buildEvidenceMessage(
      snapshot({ attachments: [att({ url: "https://cdn.example/gone" })] }),
      { resolveHost: resolvePublic, fetchImpl: makeFetch({}) },
    );
    assert.equal(missing.ok, true);
    assert.match(missing.warnings[0], /HTTP 404/);
    assert.ok(missing.warnings[0].includes("may not survive deletion"));

    const noUrl = await buildEvidenceMessage(
      snapshot({
        attachments: [{ id: "9", name: "ghost.png", url: null, size: null, contentType: null }],
      }),
    );
    assert.equal(noUrl.ok, true);
    assert.ok(noUrl.warnings[0].includes("ghost.png"));
    assert.ok(noUrl.warnings[0].includes("no source URL"));
    assert.ok(noUrl.warnings[0].includes("may not survive deletion"));
  });

  it("caps how many files it fetches and says so with the phrase", async () => {
    const routes = {};
    const attachments = [];
    for (let i = 0; i < 12; i += 1) {
      routes[`https://cdn.example/f${i}.bin`] = okResponse(Buffer.from("x"), {
        contentType: "application/octet-stream",
      });
      attachments.push(
        att({ name: `f${i}.bin`, url: `https://cdn.example/f${i}.bin`, contentType: null }),
      );
    }
    const fetchImpl = makeFetch(routes);
    const res = await buildEvidenceMessage(snapshot({ attachments }), {
      fetchImpl,
      resolveHost: resolvePublic,
    });
    assert.equal(res.ok, true);
    assert.equal(fetchImpl.calls.length, 10);
    assert.equal(res.files.length, 10);
    const cap = res.warnings.find((w) => w.includes("10 of 12"));
    assert.ok(cap, `cap warning missing: ${res.warnings.join(" | ")}`);
    assert.ok(cap.includes("may not survive deletion"));
  });

  it("produces no files or warnings for an attachment-less report", async () => {
    const res = await buildEvidenceMessage(snapshot());
    assert.equal(res.ok, true);
    assert.deepEqual(res.files, []);
    assert.deepEqual(res.warnings, []);
  });
});

// ---------- output shape (what subtask 08 consumes) ----------

describe("reportEvidence output shape", () => {
  it("returns embeds (toJSON-able), {attachment: Buffer, name} files, string warnings", async () => {
    const res = await buildEvidenceMessage(
      snapshot({
        attachments: [
          att({ name: "a.png", url: "https://cdn.example/a.png" }),
          att({ name: "b.mp4", url: "https://cdn.example/b.mp4", contentType: "video/mp4" }),
        ],
      }),
      {
        contextText: "staff note here",
        deleted: true,
        resolveHost: resolvePublic,
        fetchImpl: makeFetch({
          "https://cdn.example/a.png": okResponse(Buffer.from("A"), {
            contentType: "image/png",
          }),
          "https://cdn.example/b.mp4": okResponse(Buffer.from("B"), {
            contentType: "video/mp4",
          }),
        }),
      },
    );
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.embeds) && res.embeds.length >= 2);
    for (const embed of res.embeds) {
      assert.equal(typeof embed.toJSON, "function");
    }
    for (const file of res.files) {
      assert.ok(Buffer.isBuffer(file.attachment), `file ${file.name} attachment`);
      assert.equal(typeof file.name, "string");
      assert.ok(/^[a-zA-Z0-9._-]+$/.test(file.name), `safe name: ${file.name}`);
    }
    for (const warning of res.warnings) assert.equal(typeof warning, "string");

    // every image reference resolves to exactly one shipped file name
    for (const j of raw(res.embeds)) {
      const url = j.image?.url;
      if (!url) continue;
      assert.ok(url.startsWith("attachment://"));
      const wanted = url.slice("attachment://".length);
      assert.equal(res.files.filter((f) => f.name === wanted).length, 1);
    }
  });
});
