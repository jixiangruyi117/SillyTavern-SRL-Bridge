import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as promptSlots from "../modules/PromptSlots.js";

test("slot runtime preserves prompt entries and switches each macro value with the active character", async () => {
  const source = await readFile(new URL("../modules/PromptSlotRuntime.js", import.meta.url), "utf8");
  const handlers = new Map();
  const macros = new Map();
  const preset = {
    prompts: [{ identifier: "main", name: "文风与状态", content: "文风：{{srl_slot::slot-0001::文风}}；状态：{{srl_slot::slot-0002::状态栏}}。" }],
  };
  const settings = {
    prompts: structuredClone(preset.prompts),
    prompt_order: [{ character_id: 100001, order: [
      { identifier: "main", enabled: true },
      { identifier: "optional", enabled: false },
      { identifier: "unrelated", enabled: true },
    ] }],
  };
  const context = {
    mainApi: "openai",
    characters: [{ avatar: "alice.png" }, { avatar: "bob.png" }],
    characterId: 0,
    extensionSettings: { "srl-bridge": { promptSlotValues: {
      "alice.png": { values: {} },
      "bob.png": { values: { "slot-0001": "简洁" } },
    } } },
    chatCompletionSettings: settings,
    getPresetManager: () => ({ getSelectedPresetName: () => "测试预设", getCompletionPresetByName: () => preset }),
    macros: { register: (name, macro) => macros.set(name, macro) },
  };
  const original = structuredClone(settings);
  const sandbox = vm.createContext({
    ...promptSlots,
    window: { SillyTavern: { getContext: () => context } },
    document: { dispatchEvent() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    console,
    event_types: Object.fromEntries(["APP_READY", "CHAT_CHANGED", "CHAT_LOADED", "PRESET_CHANGED", "OAI_PRESET_CHANGED_AFTER", "MAIN_API_CHANGED"].map(key => [key, key])),
    eventSource: { on: (event, handler) => handlers.set(event, handler) },
  });
  vm.runInContext(source.replace(/^import[\s\S]*?;\s*/gm, "").replace(/^export /gm, ""), sandbox);
  sandbox.startPromptSlotRuntime();
  assert.deepEqual(settings, original, "all-empty slots must not disable or edit prompt entries");
  const macro = (id) => macros.get("srl_slot").handler({ unnamedArgs: [id, "标签"] });
  assert.equal(macro("slot-0001"), "");
  const values = context.extensionSettings["srl-bridge"].promptSlotValues["alice.png"].values;
  values["slot-0002"] = "在线";
  sandbox.refreshPromptSlots();
  assert.equal(macro("slot-0001"), "");
  assert.equal(macro("slot-0002"), "在线");
  assert.deepEqual(settings, original);
  context.chatCompletionSettings = structuredClone(settings);
  handlers.get("CHAT_LOADED")();
  assert.deepEqual(context.chatCompletionSettings, original, "reloading prompt orders must preserve their switches");
  context.characterId = 1;
  handlers.get("CHAT_CHANGED")();
  assert.equal(macro("slot-0001"), "简洁");
  assert.equal(macro("slot-0002"), "");
  assert.deepEqual(context.chatCompletionSettings, original);
  context.chatCompletionSettings.prompt_order[0].order[0].enabled = false;
  const manuallyDisabled = structuredClone(context.chatCompletionSettings);
  context.characterId = 0;
  handlers.get("CHAT_CHANGED")();
  assert.deepEqual(context.chatCompletionSettings, manuallyDisabled, "a user's disabled entry must stay disabled");
});
