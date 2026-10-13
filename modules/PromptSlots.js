const SLOT_MACRO_PATTERN = /\{\{\s*srl_slot::([a-z\d-]{8,64})::([^:{}\r\n]{1,80})\s*\}\}/giu;

export function normalizePromptSlotMetadata(metadata) {
  if (
    !metadata ||
    metadata.schemaVersion !== 1 ||
    !Array.isArray(metadata.entries)
  ) return [];

  return metadata.entries.flatMap((entry) => {
    if (
      !entry ||
      typeof entry.identifier !== "string" ||
      entry.emptyBehavior !== "hide-entry" ||
      !Array.isArray(entry.slots)
    ) return [];
    const slots = entry.slots.filter(
      (slot) => typeof slot?.id === "string" && typeof slot?.label === "string",
    );
    return slots.length
      ? [{ identifier: entry.identifier, name: String(entry.name || entry.identifier), slots }]
      : [];
  });
}

export function normalizePromptSlotValues(value) {
  const values = value?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(
    Object.entries(values).filter(([id, text]) => id && typeof text === "string"),
  );
}

export function getCharacterPromptSlotValues(extensionSettings, avatar) {
  if (typeof avatar !== "string" || !avatar) return {};
  return normalizePromptSlotValues(extensionSettings?.["srl-bridge"]?.promptSlotValues?.[avatar]);
}

export function discoverCurrentPromptSlotMetadata(context) {
  if (!context || (context.mainApi && context.mainApi !== "openai")) return [];
  // Live settings include prompt edits that have not been saved back to the preset.
  if (Array.isArray(context.chatCompletionSettings?.prompts)) {
    return discoverPromptSlotMetadata(context.chatCompletionSettings);
  }
  const manager = context.getPresetManager?.("openai");
  const name = manager?.getSelectedPresetName?.();
  return discoverPromptSlotMetadata(name ? manager.getCompletionPresetByName?.(name) : null);
}

export function discoverPromptSlotMetadata(preset) {
  const entries = normalizePromptSlotMetadata(preset?.extensions?.srl_prompt_slots);
  const byIdentifier = new Map(entries.map((entry) => [entry.identifier, {
    ...entry,
    slots: [...entry.slots],
  }]));
  for (const prompt of Array.isArray(preset?.prompts) ? preset.prompts : []) {
    if (typeof prompt?.identifier !== "string" || typeof prompt.content !== "string") continue;
    SLOT_MACRO_PATTERN.lastIndex = 0;
    const slots = [...prompt.content.matchAll(SLOT_MACRO_PATTERN)];
    if (!slots.length) continue;
    const entry = byIdentifier.get(prompt.identifier) || {
      identifier: prompt.identifier,
      name: typeof prompt.name === "string" && prompt.name.trim()
        ? prompt.name.trim()
        : prompt.identifier,
      slots: [],
    };
    const slotIds = new Set(entry.slots.map((slot) => slot.id));
    for (const [, id, label] of slots) {
      if (slotIds.has(id)) continue;
      slotIds.add(id);
      entry.slots.push({ id, label: label.trim() });
    }
    byIdentifier.set(prompt.identifier, entry);
  }
  return [...byIdentifier.values()];
}

export function resolvePromptSlotValue(values, id) {
  const value = values?.[id];
  return typeof value === "string" ? value : "";
}

export function replacePromptSlotMacro(id, _label, values) {
  return resolvePromptSlotValue(values, id);
}
