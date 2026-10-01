import { eventSource, event_types } from "/scripts/events.js";
import { user_avatar } from "/scripts/personas.js";
import { power_user } from "/scripts/power-user.js";
import { extension_prompt_types, getCurrentChatId } from "/script.js";
import { buildPersonaVariantPrompt } from "./PersonaVariantProfile.js";

const PROMPT_ID = "srl-persona-character-variant";

export function refreshPersonaVariantPrompt() {
  const context = window.SillyTavern?.getContext?.();
  if (!context?.setExtensionPrompt) return "";

  const character = context.characters?.[context.characterId];
  const descriptor = power_user.persona_descriptions?.[user_avatar];
  const prompt = character?.avatar
    ? buildPersonaVariantPrompt(
        descriptor?.srl_persona_profile,
        character.avatar,
        getCurrentChatId?.() || "",
      )
    : "";
  context.setExtensionPrompt(
    PROMPT_ID,
    prompt,
    extension_prompt_types.IN_PROMPT,
    0,
    false,
  );
  const status = document.querySelector(
    "#srl-persona-variant-manager [data-role='status']",
  );
  if (status) {
    status.dataset.active = String(Boolean(prompt));
    status.textContent = prompt
      ? `已为“${power_user.personas?.[user_avatar] || "当前人设"}”应用“${character.name || character.avatar}”的 char 补充。`
      : character
        ? `当前角色卡“${character.name || character.avatar}”没有 char 补充。`
        : "未检测到单角色聊天，char 补充未注入。";
  }
  return prompt;
}

export function startPersonaVariantRuntime() {
  const refresh = () => {
    try {
      refreshPersonaVariantPrompt();
    } catch (error) {
      console.warn("SRL Bridge: 人设 char 补充未能刷新", error);
    }
  };

  for (const event of [
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.CHAT_LOADED,
    event_types.PERSONA_CHANGED,
  ]) {
    eventSource.on(event, refresh);
  }
  refresh();
}
