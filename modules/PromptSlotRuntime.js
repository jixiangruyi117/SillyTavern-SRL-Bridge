import { eventSource, event_types } from "/scripts/events.js";
import { discoverPromptSlotMetadata, getCharacterPromptSlotValues, reconcilePromptOrderVisibility, replacePromptSlotMacro } from "./PromptSlots.js";

let registered = false;
const controlledOrders = new Map();

function getContext() {
  return window.SillyTavern?.getContext?.();
}

function currentPresetMetadata(context) {
  if (context?.mainApi && context.mainApi !== "openai") return [];
  const manager = context?.getPresetManager?.("openai");
  const presetName = manager?.getSelectedPresetName?.();
  const preset = presetName ? manager.getCompletionPresetByName?.(presetName) : null;
  return discoverPromptSlotMetadata(preset);
}

function currentValues(context) {
  const character = context?.characters?.[context.characterId];
  return getCharacterPromptSlotValues(context?.extensionSettings, character?.avatar);
}

function applyEntryVisibility(context, metadata, values) {
  const orders = context?.chatCompletionSettings?.prompt_order;
  reconcilePromptOrderVisibility(orders, metadata, values, controlledOrders);
}

export function refreshPromptSlots() {
  const context = getContext();
  if (!context) return { entries: [], values: {} };
  const entries = currentPresetMetadata(context);
  const values = currentValues(context);
  applyEntryVisibility(context, entries, values);
  document.dispatchEvent(new CustomEvent("srl-prompt-slots-updated", {
    detail: { entries, values, character: context.characters?.[context.characterId] || null },
  }));
  return { entries, values };
}

export function startPromptSlotRuntime() {
  if (registered) return;
  registered = true;
  const macros = getContext()?.macros;
  if (typeof macros?.register === "function") {
    macros.register("srl_slot", {
      category: "misc",
      description: "替换为当前角色卡填写的预设占位内容",
      unnamedArgs: 2,
      handler: ({ unnamedArgs }) => replacePromptSlotMacro(unnamedArgs[0], unnamedArgs[1], currentValues(getContext())),
    });
  }

  const refresh = () => {
    try {
      refreshPromptSlots();
    } catch (error) {
      console.warn("SRL Bridge: 预设占位未能刷新", error);
    }
  };
  for (const event of [
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.CHAT_LOADED,
    event_types.PRESET_CHANGED,
    event_types.OAI_PRESET_CHANGED_AFTER,
    event_types.MAIN_API_CHANGED,
  ]) {
    if (event) eventSource.on(event, refresh);
  }
  refresh();
}
