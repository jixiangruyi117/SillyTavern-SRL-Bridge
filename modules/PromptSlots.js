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

export function isPromptSlotEntryComplete(entry, values) {
  return entry.slots.every((slot) => resolvePromptSlotValue(values, slot.id).trim());
}

export function replacePromptSlotMacro(id, _label, values) {
  return resolvePromptSlotValue(values, id);
}

export function reconcilePromptOrderVisibility(orderGroups, entries, values, controlledOrders) {
  for (const [order, state] of controlledOrders) {
    if (order.enabled !== state.applied) state.original = Boolean(order.enabled);
    order.enabled = state.original;
  }
  controlledOrders.clear();

  const visibility = new Map(entries.map((entry) => [
    entry.identifier,
    isPromptSlotEntryComplete(entry, values),
  ]));
  for (const promptOrder of orderGroups || []) {
    for (const order of promptOrder?.order || []) {
      if (!visibility.has(order.identifier)) continue;
      const original = Boolean(order.enabled);
      const enabled = original && visibility.get(order.identifier);
      order.enabled = enabled;
      controlledOrders.set(order, { original, applied: enabled });
    }
  }
}
