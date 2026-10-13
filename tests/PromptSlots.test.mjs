import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverCurrentPromptSlotMetadata,
  discoverPromptSlotMetadata,
  getCharacterPromptSlotValues,
  normalizePromptSlotMetadata,
  normalizePromptSlotValues,
  replacePromptSlotMacro,
} from "../modules/PromptSlots.js";

test("reads newly edited and removed macros from live settings instead of the saved preset", () => {
  const saved = { prompts: [{ identifier: "main", content: "{{srl_slot::slot-old1::旧变量}}" }] };
  const context = {
    mainApi: "openai",
    chatCompletionSettings: { prompts: [{ identifier: "main", content: "{{srl_slot::slot-new1::新变量}}" }] },
    getPresetManager: () => ({ getSelectedPresetName: () => "预设", getCompletionPresetByName: () => saved }),
  };
  assert.deepEqual(discoverCurrentPromptSlotMetadata(context)[0].slots, [{ id: "slot-new1", label: "新变量" }]);
  context.chatCompletionSettings.prompts = [];
  assert.deepEqual(discoverCurrentPromptSlotMetadata(context), [], "an empty live preset must not resurrect saved macros");
  delete context.chatCompletionSettings;
  assert.deepEqual(discoverCurrentPromptSlotMetadata(context)[0].slots, [{ id: "slot-old1", label: "旧变量" }]);
  context.mainApi = "textgenerationwebui";
  assert.deepEqual(discoverCurrentPromptSlotMetadata(context), []);
  assert.deepEqual(discoverCurrentPromptSlotMetadata(null), []);
});

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

test("empty slots leave only their positions blank while other slots and surrounding text remain", () => {
  const template = "文风：{{srl_slot::slot-0001::文风}}；状态：{{srl_slot::slot-0002::状态栏}}。";
  const render = (values) => template.replace(/\{\{srl_slot::([^:]+)::([^}]+)\}\}/g,
    (_, id, label) => replacePromptSlotMacro(id, label, values));
  assert.equal(render({}), "文风：；状态：。");
  assert.equal(render({ "slot-0002": "在线" }), "文风：；状态：在线。");
  assert.equal(render({ "slot-0001": "克制、简洁", "slot-0002": "在线" }), "文风：克制、简洁；状态：在线。");
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
