/**
 * Integration (issue #188 / audit C5): a member-authored cloud-metadata URL
 * in a ticket NEVER leaves the process during archive.
 *
 * Full offline full-stack flow (mocked Discord I/O via the shared harness,
 * REAL SQLite, REAL DATA_DIR): staff opens a ticket, the ticket channel
 * contains a message whose attachment points at the AWS/GCP-style metadata
 * IP (https AND http variants), then /ticket close + /ticket archive run for
 * real. Throughout archive, globalThis.fetch AND dns.promises.lookup are
 * tripwired: the guard must refuse the literal addresses BEFORE either is
 * touched, the archive must still complete (transcript saved, row archived),
 * and the archive reply must carry the specific refusal as a warning — the
 * exfiltration read that C5 described is impossible at this layer.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");
const { createIntegrationEnv } = require("../helpers/harness");
const { IDS } = require("../helpers/fixtures");

const METADATA_URLS = [
  "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://169.254.169.254/latest/meta-data/",
];

describe("integration: ticket-archive SSRF guard (C5)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let origFetch;
  let origLookup;
  const attempted = { fetch: [], dns: [] };

  before(async () => {
    env = await createIntegrationEnv();
    process.env.DATA_DIR = env.tmpDir;
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "senior");
    env.db.updateGuildSettings(env.communityId, {
      ticket_archive_channel_id: IDS.channelLog,
      ticket_rate_limit_minutes: 0,
    });

    const ticketsFeature = require("../../src/features/tickets");
    ticketsFeature.registerEvents(env.supervisor, env.ctx);

    // Requester DM resolution (same as the main tickets integration env).
    if (!env.client.users) {
      const userCache = new Map(
        [env.users.adminUser, env.users.memberUser, env.users.botUser].map((u) => [u.id, u])
      );
      env.client.users = {
        cache: userCache,
        fetch: async (id) => userCache.get(id) || null,
      };
    }

    // --- tripwires: ANY network attempt during this suite is a failure -----
    origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      attempted.fetch.push(String(url));
      throw new Error(`TRIPOWIRE: fetch attempted for ${url}`);
    };
    origLookup = dns.promises.lookup;
    dns.promises.lookup = async (host) => {
      attempted.dns.push(String(host));
      throw new Error(`TRIPOWIRE: DNS lookup attempted for ${host}`);
    };
  });

  after(() => {
    globalThis.fetch = origFetch;
    dns.promises.lookup = origLookup;
    env?.cleanup();
  });

  it("metadata attachment is refused before DNS/fetch; archive completes with a named warning", async () => {
    // 1. Staff opens the ticket for the member.
    const reason = "ssrf-c5-probe";
    const open = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: true,
      options: { user: env.users.memberUser, reason },
    });
    assert.match(env.lastReplyContent(open), /opened|Ticket/i);
    const rows = env.db.listOpenTickets(env.communityId, { userId: IDS.member, limit: 10 });
    const ticket = rows.find((t) => t.reason === reason);
    assert.ok(ticket, "expected open ticket");

    // 2. The member posts a message whose attachment targets cloud metadata.
    const ticketChannel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(ticketChannel);
    ticketChannel.addMessage({
      id: "ssrf-probe-1",
      content: "look at this file",
      author: { id: IDS.member, username: "member", tag: "member#0000" },
      attachments: [
        {
          url: METADATA_URLS[0],
          name: "creds.json",
          contentType: "application/json",
          proxyURL: METADATA_URLS[0],
        },
        { url: METADATA_URLS[1], name: "meta", contentType: "text/plain" },
      ],
    });

    // 3. Close + archive run the REAL pipeline.
    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: { reason: "probe" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    attempted.fetch.length = 0;
    attempted.dns.length = 0;

    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: ticket.channel_id,
    });
    const archiveText = env.lastReplyContent(archive);
    assert.match(archiveText, /archived/i);

    // 4. NOTHING left the process: no DNS query, no fetch — for either URL.
    assert.deepEqual(attempted.fetch, [], `archive must never fetch: ${attempted.fetch}`);
    assert.deepEqual(attempted.dns, [], `archive must never resolve DNS: ${attempted.dns}`);

    // 5. The refusal is REPORTED (not silently dropped): specific per-file
    //    warnings naming the host and the refused address range.
    assert.match(archiveText, /Media not archived/u);
    assert.match(archiveText, /refused address range for 169\.254\.169\.254/);
    assert.match(archiveText, /non-https url \(http:\)/);

    // 6. The archive itself still succeeded (partial-failure rule).
    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 1);
    assert.ok(after.transcript_token, "transcript token issued");
    assert.ok(after.transcript_path, "transcript written");

    //    No asset bytes were written under the transcript's assets dir.
    const assetsDir = path.join(
      env.tmpDir,
      "ticket-transcripts",
      String(env.communityId),
      after.transcript_token,
      "assets"
    );
    if (fs.existsSync(assetsDir)) {
      assert.deepEqual(fs.readdirSync(assetsDir), [], "no asset file may exist");
    }

    //    The stored rows keep the attachment as a REMOTE ref (local:false),
    //    provenance preserved, and it can never be re-served as an asset.
    const messages = env.db.listTicketMessages(ticket.id);
    assert.ok(messages.length >= 1);
    const msg = messages.find((m) => m.content === "look at this file");
    assert.ok(msg, "probe message persisted");
    const atts =
      typeof msg.attachment_urls === "string"
        ? JSON.parse(msg.attachment_urls)
        : msg.attachment_urls;
    assert.equal(atts[0].local, false);
    assert.equal(atts[0].url, METADATA_URLS[0]);
    assert.equal(atts[1].local, false);
  });
});
