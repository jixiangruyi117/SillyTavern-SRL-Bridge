function normalizeOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([sectionId, override]) => {
      if (override?.mode === "disable") return [[sectionId, { mode: "disable" }]];
      if (override?.mode === "replace" && typeof override.text === "string") {
        return [[sectionId, { mode: "replace", text: override.text }]];
      }
      return [];
    }),
  );
}

function normalizeVersion(id, value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    id,
    name: typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : index === 0 ? "默认版本" : `版本 ${index + 1}`,
    overrides: normalizeOverrides(value.overrides),
    addition: typeof value.addition === "string" ? value.addition : "",
  };
}

function normalizeVariant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let versions;
  let defaultVersionId;
  let chatVersions = {};

  if (value.versions && typeof value.versions === "object" && !Array.isArray(value.versions)) {
    versions = Object.fromEntries(
      Object.entries(value.versions)
        .map(([id, version], index) => [id, normalizeVersion(id, version, index)])
        .filter(([, version]) => version),
    );
    defaultVersionId = typeof value.defaultVersionId === "string" ? value.defaultVersionId : "";
    if (value.chatVersions && typeof value.chatVersions === "object" && !Array.isArray(value.chatVersions)) {
      chatVersions = Object.fromEntries(
        Object.entries(value.chatVersions).filter(
          ([chatId, versionId]) => typeof chatId === "string" && typeof versionId === "string",
        ),
      );
    }
  } else {
    const version = normalizeVersion("default", value);
    versions = version ? { default: { ...version, name: "默认版本" } } : {};
    defaultVersionId = "default";
  }

  const versionIds = Object.keys(versions);
  if (!versionIds.length) return null;
  if (!versions[defaultVersionId]) defaultVersionId = versionIds[0];
  for (const [chatId, versionId] of Object.entries(chatVersions)) {
    if (!versions[versionId]) delete chatVersions[chatId];
  }
  return { versions, defaultVersionId, chatVersions };
}

export function getPersonaVariantVersion(variant, chatId = "") {
  if (!variant || typeof variant !== "object") return null;
  const normalized = variant.versions ? variant : normalizeVariant(variant);
  if (!normalized?.versions || typeof normalized.versions !== "object") return null;
  const chatKey = chatId ? String(chatId) : "__default__";
  const selectedId = normalized.chatVersions?.[chatKey];
  return normalized.versions[selectedId] ||
    normalized.versions[normalized.defaultVersionId] ||
    Object.values(normalized.versions)[0] ||
    null;
}

export function normalizePersonaVariantProfile(value, fallbackDescription = "") {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.sections) ||
    !value.variants ||
    typeof value.variants !== "object" ||
    Array.isArray(value.variants)
  ) {
    return {
      version: 1,
      sections: [{ id: "base", name: "基础设定", text: fallbackDescription }],
      variants: {},
    };
  }
  const sections = value.sections.filter(
    (section) =>
      section &&
      typeof section.id === "string" &&
      typeof section.name === "string" &&
      typeof section.text === "string",
  );
  const normalizedSections = sections.length
    ? sections.map((section) => ({ ...section }))
    : [{ id: "base", name: "基础设定", text: fallbackDescription }];
  const baseSection = normalizedSections.find((section) => section.id === "base");
  if (baseSection) baseSection.text = fallbackDescription;
  const variants = Object.fromEntries(
    Object.entries(value.variants).flatMap(([characterId, variant]) => {
      const normalized = normalizeVariant(variant);
      return normalized ? [[characterId, normalized]] : [];
    }),
  );
  return { version: 1, sections: normalizedSections, variants };
}

function getVersionContent(profile, characterId, chatId) {
  return getPersonaVariantVersion(profile?.variants?.[characterId], chatId);
}

export function buildPersonaVariantPrompt(profile, characterId, chatId = "") {
  if (
    !profile ||
    profile.version !== 1 ||
    !Array.isArray(profile.sections) ||
    !profile.variants ||
    typeof profile.variants !== "object"
  ) {
    return "";
  }

  const variant = getVersionContent(profile, characterId, chatId);
  if (!variant) return "";

  const instructions = [];
  for (const section of profile.sections) {
    if (!section || typeof section.id !== "string") continue;
    const override = variant.overrides?.[section.id];
    if (override?.mode === "disable") {
      instructions.push(
        `- ${String(section.name || "全局设定")}：本角色卡下不采用全局设定中的这一项。`,
      );
    } else if (
      override?.mode === "replace" &&
      typeof override.text === "string" &&
      override.text.trim()
    ) {
      instructions.push(
        `- ${String(section.name || "全局设定")}：本角色卡下改为“${override.text.trim()}”，以此覆盖全局设定。`,
      );
    }
  }

  const addition = typeof variant.addition === "string" ? variant.addition.trim() : "";
  if (!instructions.length && !addition) return "";
  return [
    "【当前角色卡下的用户人设调整】",
    ...instructions,
    ...(addition ? ["【仅对此角色卡追加】", addition] : []),
  ].join("\n");
}

export function countPersonaVariantItems(profile, characterId) {
  const variant = normalizeVariant(profile?.variants?.[characterId]);
  return variant ? Object.keys(variant.versions).length : 0;
}

export function resolvePersonaVariantPreview(profile, characterId, chatId = "") {
  const variant = getVersionContent(profile, characterId, chatId);
  const sections = (profile?.sections || []).flatMap((section) => {
    const override = variant?.overrides?.[section.id];
    if (override?.mode === "disable") return [];
    if (override?.mode === "replace") {
      if (typeof override.text !== "string" || !override.text.trim()) return [];
      return [
        ...(section.text.trim()
          ? [`${section.name}（当前全局内容，未用于此版本）`, section.text.trim()]
          : []),
        `${section.name}（此版本实际生效）`,
        override.text.trim(),
      ];
    }
    return section.text.trim() ? [`${section.name}`, section.text.trim()] : [];
  });
  if (variant?.addition?.trim()) {
    sections.push("仅对此角色追加", variant.addition.trim());
  }
  return sections;
}
