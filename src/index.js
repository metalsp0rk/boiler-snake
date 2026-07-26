// src/index.js — thin entry: env, client, features, ordered pipelines, login
require("dotenv").config();

const { Events } = require("discord.js");
const { assertRuntimeEnv } = require("./config");
const { createClient } = require("./client");
const { buildDefaultRegistry } = require("./commands/registry");
const { handleInteraction } = require("./commands/router");
const features = require("./features");
const {
  registerAllFeatureEvents,
  startAllFeatures,
} = require("./features/load");
const { registerOrderedPipelines } = require("./bot/pipelines");
const { ensureHoneypotWarning } = require("./features/honeypot");

assertRuntimeEnv();

const client = createClient();
const registry = buildDefaultRegistry();
const featureCtx = { client, registry, ensureHoneypotWarning };

registerAllFeatureEvents(client, features, featureCtx);
registerOrderedPipelines(client);

client.once(Events.ClientReady, () => {
  console.log(`Boiler Snake logged in as ${client.user.tag}`);
  startAllFeatures(client, features, featureCtx);
});

client.on(Events.InteractionCreate, (interaction) =>
  handleInteraction(interaction, featureCtx)
);

client.login(process.env.DISCORD_TOKEN);
