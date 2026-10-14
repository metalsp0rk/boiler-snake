/**
 * Unit tests: /event quick-edit modal payload shape (epic #218).
 *
 * Regression guard for Discord 50035 / TEXT_INPUT_COMPONENT_LABEL_IN_LABEL_COMPONENT:
 * in components-v2 modals every field is a Label component (type 17) wrapping the
 * input, and the nested TextInput must NOT carry its own `label` key — Discord
 * rejects the whole modal otherwise. `required` stays on the input (LabelBuilder
 * has no setRequired). The fake interaction never validates showModal payloads,
 * so this shape is asserted here instead.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { ComponentType } = require("discord.js");
const { buildEditModal } = require("../src/features/events/ui");

const EVENT = {
  id: 42,
  title: "Game Night",
  start_at: Date.UTC(2026, 10, 5, 19, 0, 0),
  creator_id: "1",
};

describe("buildEditModal payload shape", () => {
  const json = buildEditModal(EVENT).toJSON();

  it("wraps every field in a Label component keyed to the right input", () => {
    const labels = json.components;
    assert.equal(labels.length, 4);
    for (const l of labels) {
      assert.equal(l.type, ComponentType.Label);
      assert.ok(l.label?.length >= 1 && l.label.length <= 45, `label text: ${l.label}`);
    }
    assert.deepEqual(
      labels.map((l) => [l.label, l.component.custom_id, l.component.type]),
      [
        ["Title", "title", ComponentType.TextInput],
        ["Start time (blank = unchanged)", "start", ComponentType.TextInput],
        ["Description (blank = keep, '-' = clear)", "description", ComponentType.TextInput],
        ["Location (blank = keep, '-' = clear)", "location", ComponentType.TextInput],
      ]
    );
  });

  it("nested text inputs never carry their own label key", () => {
    for (const l of json.components) {
      assert.equal(
        "label" in l.component,
        false,
        `TextInput "${l.component.custom_id}" inside a Label must not set label`
      );
    }
  });

  it("required flags live on the inputs (title only)", () => {
    const byId = Object.fromEntries(
      json.components.map((l) => [l.component.custom_id, l.component])
    );
    assert.equal(byId.title.required, true);
    assert.equal(byId.start.required, false);
    assert.equal(byId.description.required, false);
    assert.equal(byId.location.required, false);
  });

  it("prefills the title and keeps the customId contract", () => {
    const title = json.components[0].component;
    assert.equal(title.value, "Game Night");
    assert.match(json.custom_id, /^evm:edit:42$/);
  });
});
