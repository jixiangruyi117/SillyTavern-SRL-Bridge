import test from "node:test";
import assert from "node:assert/strict";
import {
  isPromptSlotEntryComplete,
  discoverPromptSlotMetadata,
  getCharacterPromptSlotValues,
  normalizePromptSlotMetadata,
  normalizePromptSlotValues,
  reconcilePromptOrderVisibility,
  replacePromptSlotMacro,
} from "../modules/PromptSlots.js";

test("accepts the resource library schema and filters malformed slot entries", () => {
  assert.deepEqual(normalizePromptSlotMetadata({
    schemaVersion: 1,
    entries: [
      {
        identifier: "main",
        name: "主预设",
        emptyBehavior: "hide-entry",
        slots: [{ id: "slot-0001", label: "文风" }],
      },
      { identifier: "other", emptyBehavior: "show-entry", slots: [{ id: "x", label: "忽略" }] },
      { identifier: "bad", emptyBehavior: "hide-entry", slots: [{ id: 1, label: "忽略" }] },
    ],
  }), [{ identifier: "main", name: "主预设", slots: [{ id: "slot-0001", label: "文风" }] }]);
  assert.deepEqual(normalizePromptSlotMetadata({ schemaVersion: 2, entries: [] }), []);
});

test("empty values hide the associated entry and filled values replace macros", () => {
  const entry = { slots: [{ id: "style", label: "文风" }] };
  assert.equal(isPromptSlotEntryComplete(entry, {}), false);
  assert.equal(isPromptSlotEntryComplete(entry, { style: "  " }), false);
  assert.equal(isPromptSlotEntryComplete(entry, { style: "克制、简洁" }), true);
  assert.equal(replacePromptSlotMacro("style", "文风", { style: "克制、简洁" }), "克制、简洁");
  assert.equal(replacePromptSlotMacro("missing", "文风", {}), "");
});

test("reads per-character saved values without accepting malformed values", () => {
  assert.deepEqual(normalizePromptSlotValues({ schemaVersion: 1, values: { a: "text", b: 2, c: null } }), { a: "text" });
  assert.deepEqual(normalizePromptSlotValues({ values: [] }), {});
});

test("discovers hand-written slot macros and associates them with prompt entries", () => {
  const entries = discoverPromptSlotMetadata({
    prompts: [
      { identifier: "style-prompt", name: "文风", content: "采用 {{srl_slot::slot-0001::文风}}。" },
      { identifier: "header", name: "状态栏", content: "{{srl_slot::slot-0002::状态栏}}\n{{srl_slot::slot-0003::副标题}}" },
      { identifier: "invalid", name: "无效项", content: "{{srl_slot::short::忽略}}" },
    ],
  });
  assert.deepEqual(entries, [
    { identifier: "style-prompt", name: "文风", slots: [{ id: "slot-0001", label: "文风" }] },
    { identifier: "header", name: "状态栏", slots: [
      { id: "slot-0002", label: "状态栏" },
      { id: "slot-0003", label: "副标题" },
    ] },
  ]);
});

test("keeps slot values local and separated by character avatar", () => {
  const settings = {
    "srl-bridge": {
      promptSlotValues: {
        "alice.png": { schemaVersion: 1, values: { style: "Alice 文风" } },
        "bob.png": { schemaVersion: 1, values: { style: "Bob 文风" } },
      },
    },
  };
  assert.deepEqual(getCharacterPromptSlotValues(settings, "alice.png"), { style: "Alice 文风" });
  assert.deepEqual(getCharacterPromptSlotValues(settings, "bob.png"), { style: "Bob 文风" });
  assert.deepEqual(getCharacterPromptSlotValues(settings, "missing.png"), {});
});

test("hides only slot entries and restores their original enabled state", () => {
  const groups = [{ order: [
    { identifier: "main", enabled: true },
    { identifier: "optional", enabled: false },
    { identifier: "unrelated", enabled: true },
  ] }];
  const entry = { identifier: "main", slots: [{ id: "style", label: "文风" }] };
  const controlled = new Map();
  reconcilePromptOrderVisibility(groups, [entry], {}, controlled);
  assert.deepEqual(groups[0].order.map(({ enabled }) => enabled), [false, false, true]);
  reconcilePromptOrderVisibility(groups, [entry], { style: "清爽" }, controlled);
  assert.deepEqual(groups[0].order.map(({ enabled }) => enabled), [true, false, true]);
});
