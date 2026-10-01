import { eventSource, event_types } from "/scripts/events.js";
import { user_avatar } from "/scripts/personas.js";
import { power_user } from "/scripts/power-user.js";
import { extension_prompt_types, getCurrentChatId } from "/script.js";
import {
  getPersonaVariantVersion,
  normalizePersonaVariantProfile,
  resolvePersonaVariantPrompt,
} from "./PersonaVariantProfile.js";

const LEGACY_PROMPT_ID = "srl-persona-character-variant";
let temporaryPersonaDescription = null;

function restoreGlobalPersonaDescription() {
  if (!temporaryPersonaDescription) return;
  const { original, injected } = temporaryPersonaDescription;
  // Preserve a user's edit made while generation was running.
  if (power_user.persona_description === injected) {
    power_user.persona_description = original;
  }
  temporaryPersonaDescription = null;
}

function useCharacterPersonaForGeneration() {
  restoreGlobalPersonaDescription();
  const context = window.SillyTavern?.getContext?.();
  const character = context?.characters?.[context.characterId];
  const descriptor = power_user.persona_descriptions?.[user_avatar];
  if (!character?.avatar || !descriptor?.srl_persona_profile) return;
  const profile = normalizePersonaVariantProfile(
    descriptor.srl_persona_profile,
    descriptor.description || "",
  );
  const chatId = getCurrentChatId?.() || "";
  const version = getPersonaVariantVersion(
    profile.variants?.[character.avatar],
    chatId,
  );
  if (!version) return;

  const resolved = resolvePersonaVariantPrompt(
    profile,
    character.avatar,
    chatId,
  );

  const original = power_user.persona_description || "";
  temporaryPersonaDescription = { original, injected: resolved };
  power_user.persona_description = resolved;
}

export function refreshPersonaVariantPrompt() {
  restoreGlobalPersonaDescription();
  const context = window.SillyTavern?.getContext?.();
  if (!context) return "";
  context.setExtensionPrompt?.(
    LEGACY_PROMPT_ID,
    "",
    extension_prompt_types.IN_PROMPT,
    0,
    false,
  );

  const character = context.characters?.[context.characterId];
  const descriptor = power_user.persona_descriptions?.[user_avatar];
  const profile = descriptor?.srl_persona_profile
    ? normalizePersonaVariantProfile(
        descriptor.srl_persona_profile,
        descriptor.description || "",
      )
    : null;
  const chatId = getCurrentChatId?.() || "";
  const version = character?.avatar
    ? getPersonaVariantVersion(
        profile?.variants?.[character.avatar],
        chatId,
      )
    : null;
  const prompt = character?.avatar
    ? resolvePersonaVariantPrompt(
        profile,
        character.avatar,
        chatId,
      )
    : "";
  const status = document.querySelector(
    "#srl-persona-variant-manager [data-role='status']",
  );
  if (status) {
    status.dataset.active = String(Boolean(version));
    status.textContent = version
      ? `“${power_user.personas?.[user_avatar] || "当前人设"}”在生成时将使用“${character.name || character.avatar}”对应的完整人设。`
      : character
        ? `当前角色卡“${character.name || character.avatar}”使用全局人设。`
        : "未检测到单角色聊天，使用全局人设。";
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
  eventSource.on(event_types.GENERATION_AFTER_COMMANDS, useCharacterPersonaForGeneration);
  eventSource.on(event_types.GENERATION_ENDED, restoreGlobalPersonaDescription);
  refresh();
}
