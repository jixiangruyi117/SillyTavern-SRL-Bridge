import { eventSource, event_types } from "/scripts/events.js";
import { discoverCurrentPromptSlotMetadata, getCharacterPromptSlotValues, replacePromptSlotMacro } from "./PromptSlots.js";

let registered = false;

function getContext() {
  return window.SillyTavern?.getContext?.();
}

function currentValues(context) {
  const character = context?.characters?.[context.characterId];
  return getCharacterPromptSlotValues(context?.extensionSettings, character?.avatar);
}

export function refreshPromptSlots() {
  const context = getContext();
  if (!context) return { entries: [], values: {} };
  const entries = discoverCurrentPromptSlotMetadata(context);
  const values = currentValues(context);
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
