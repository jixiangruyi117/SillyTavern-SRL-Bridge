import { eventSource, event_types } from "/scripts/events.js";
import { saveSettingsDebounced } from "/script.js";
import { discoverCurrentPromptSlotMetadata, getCharacterPromptSlotValues } from "./PromptSlots.js";
import { refreshPromptSlots } from "./PromptSlotRuntime.js?v=0.3.60";

let saving = Promise.resolve();
const saveTimers = new Map();

function getContext() {
  return window.SillyTavern?.getContext?.();
}

function element(tag, className, text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function activePresetName(context) {
  return context?.getPresetManager?.("openai")?.getSelectedPresetName?.() || "";
}

function scheduleSave(panel, character, context, id, value) {
  context.extensionSettings ||= {};
  const store = context.extensionSettings["srl-bridge"] ||= {};
  const values = store.promptSlotValues ||= {};
  const characterValues = values[character.avatar] ||= {};
  characterValues.values ||= {};
  characterValues.values[id] = value;
  clearTimeout(saveTimers.get(id));
  panel.querySelector("[data-role='status']").textContent = "未保存";
  refreshPromptSlots();
  saveTimers.set(id, setTimeout(() => {
    const isCurrentCard = () => panel.dataset.avatar === character.avatar;
    if (isCurrentCard()) panel.querySelector("[data-role='status']").textContent = "保存中…";
    saving = saving.then(async () => {
      saveSettingsDebounced();
      if (isCurrentCard()) panel.querySelector("[data-role='status']").textContent = "已保存";
      refreshPromptSlots();
    }).catch((error) => {
      if (isCurrentCard()) panel.querySelector("[data-role='status']").textContent = "保存失败";
      console.warn("SRL Bridge: 角色卡占位保存失败", error);
    });
  }, 500));
}

function render(snapshot) {
  const panel = document.getElementById("srl-prompt-slots");
  if (!panel) return;
  const context = getContext();
  const entries = snapshot?.entries || discoverCurrentPromptSlotMetadata(context);
  const character = context?.characters?.[context.characterId];
  const fields = panel.querySelector("[data-role='fields']");
  fields.replaceChildren();
  panel.hidden = !context || Boolean(context.mainApi && context.mainApi !== "openai");
  if (panel.hidden) return;

  panel.dataset.avatar = character?.avatar || "";
  panel.querySelector("[data-role='character']").textContent = character
    ? `${character.name || character.avatar} · ${activePresetName(context)} · 当前角色卡`
    : `请先打开单角色聊天 · ${activePresetName(context)}`;
  const values = snapshot?.values || getCharacterPromptSlotValues(context?.extensionSettings, character?.avatar);
  const inputsBySlot = new Map();
  for (const entry of entries) {
    const card = element("section", "srl-prompt-slots__entry");
    const title = element("h4", "", entry.name || entry.identifier);
    card.append(title);
    for (const slot of entry.slots) {
      if (typeof slot?.id !== "string" || typeof slot?.label !== "string") continue;
      const label = element("label", "srl-prompt-slots__field");
      label.append(element("span", "", slot.label));
      const textarea = element("textarea", "text_pole textarea_compact");
      textarea.rows = 3;
      textarea.value = values[slot.id] || "";
      textarea.placeholder = "留空时，仅此变量位置为空，条目和其他变量保持不变";
      textarea.disabled = !character || !context?.extensionSettings;
      if (!inputsBySlot.has(slot.id)) inputsBySlot.set(slot.id, []);
      inputsBySlot.get(slot.id).push(textarea);
      textarea.addEventListener("input", () => {
        for (const peer of inputsBySlot.get(slot.id)) {
          if (peer !== textarea) peer.value = textarea.value;
        }
        scheduleSave(panel, character, context, slot.id, textarea.value);
      });
      label.append(textarea);
      card.append(label);
    }
    fields.append(card);
  }
}

export function startPromptSlotManager() {
  render();
  const panel = document.getElementById("srl-prompt-slots");
  panel?.querySelector("[data-role='refresh']")?.addEventListener("click", () => {
    const snapshot = refreshPromptSlots();
    render(snapshot);
    panel.querySelector("[data-role='status']").textContent = snapshot.entries.length ? "已刷新" : "暂无占位变量";
  });
  for (const event of [
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.CHAT_LOADED,
    event_types.PRESET_CHANGED,
    event_types.OAI_PRESET_CHANGED_AFTER,
    event_types.MAIN_API_CHANGED,
  ]) {
    if (event) eventSource.on(event, render);
  }
}
