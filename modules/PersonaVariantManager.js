import { eventSource, event_types } from "/scripts/events.js";
import { user_avatar } from "/scripts/personas.js";
import { power_user } from "/scripts/power-user.js";
import { getCurrentChatId, saveSettingsDebounced } from "/script.js";
import { refreshPersonaVariantPrompt } from "./PersonaVariantRuntime.js?v=0.3.53";
import {
  countPersonaVariantItems,
  getPersonaVariantVersion,
  normalizePersonaVariantProfile,
  resolvePersonaVariantPreview,
} from "./PersonaVariantProfile.js?v=0.3.53";

const PANEL_ID = "srl-persona-variant-manager";
const SAVED_PAGE_SIZE = 5;
let selectedCharacterId = "";
let selectedVersionId = "";
let savedPage = 0;
let versionsOpen = false;

function getContext() {
  return window.SillyTavern?.getContext?.();
}

function getChatKey() {
  const chatId = getCurrentChatId?.();
  return chatId ? String(chatId) : "__default__";
}

function getCurrentCharacter() {
  const context = getContext();
  return context?.characters?.[context.characterId];
}

function getProfile(create = false) {
  const descriptor = power_user.persona_descriptions?.[user_avatar];
  if (!descriptor) return null;
  if (create || descriptor.srl_persona_profile) {
    descriptor.srl_persona_profile = normalizePersonaVariantProfile(
      descriptor.srl_persona_profile,
      descriptor.description || "",
    );
    return descriptor.srl_persona_profile;
  }
  return normalizePersonaVariantProfile(null, descriptor.description || "");
}

function persistProfile(profile) {
  const descriptor = power_user.persona_descriptions?.[user_avatar];
  if (!descriptor) return;
  const onlyLegacyBase =
    profile.sections.length === 1 &&
    profile.sections[0].id === "base" &&
    profile.sections[0].name === "基础设定" &&
    profile.sections[0].text === (descriptor.description || "") &&
    Object.keys(profile.variants).length === 0;
  if (onlyLegacyBase) delete descriptor.srl_persona_profile;
  else descriptor.srl_persona_profile = profile;
  saveSettingsDebounced();
  refreshPersonaVariantPrompt();
}

function createElement(tag, className, text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function characterName(characterId) {
  const character = getContext()?.characters?.find((item) => item.avatar === characterId);
  return character?.name || characterId;
}

function getActiveVersionId(variant) {
  const chatVersion = variant?.chatVersions?.[getChatKey()];
  if (chatVersion && variant.versions?.[chatVersion]) return chatVersion;
  if (variant?.defaultVersionId && variant.versions?.[variant.defaultVersionId]) {
    return variant.defaultVersionId;
  }
  return Object.keys(variant?.versions || {})[0] || "";
}

function createVersionId() {
  return globalThis.crypto?.randomUUID?.() || `version-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeVersion(name, source = null) {
  return {
    id: createVersionId(),
    name,
    overrides: source ? Object.fromEntries(
      Object.entries(source.overrides || {}).map(([id, override]) => [id, { ...override }]),
    ) : {},
    addition: source?.addition || "",
  };
}

function ensureVariant(profile, characterId) {
  let variant = profile.variants[characterId];
  if (!variant) {
    const version = makeVersion("默认版本");
    variant = {
      versions: { [version.id]: version },
      defaultVersionId: version.id,
      chatVersions: {},
    };
    profile.variants[characterId] = variant;
  }
  return variant;
}

function variantHasContent(variant) {
  return Boolean(variant?.versions && Object.keys(variant.versions).length);
}

function updatePreview(panel, profile, characterId) {
  const content = panel.querySelector("[data-role='preview']");
  if (!content) return;
  content.replaceChildren();
  for (const line of resolvePersonaVariantPreview(profile, characterId, getChatKey())) {
    content.append(createElement("p", "", line));
  }
  if (!content.childElementCount) {
    content.append(createElement("p", "is-muted", "此版本当前使用完整的全局人设。"));
  }
}

function updateVariantList(panel, profile, keepCurrentPage = false) {
  const list = panel.querySelector("[data-role='saved-list']");
  const pager = panel.querySelector("[data-role='saved-pager']");
  list.replaceChildren();
  const currentCharacterId = getCurrentCharacter()?.avatar;
  const entries = Object.entries(profile.variants || {})
    .filter(([, variant]) => variantHasContent(variant))
    .sort(([a], [b]) => {
      if (a === currentCharacterId) return -1;
      if (b === currentCharacterId) return 1;
      return characterName(a).localeCompare(characterName(b), "zh-CN");
    });

  if (!entries.length) {
    list.append(createElement("p", "srl-persona-variant__empty", "还没有角色卡补充。点击“新增”，选择角色卡后开始填写。"));
    pager.hidden = true;
    return;
  }

  const pageCount = Math.ceil(entries.length / SAVED_PAGE_SIZE);
  const selectedIndex = entries.findIndex(([characterId]) => characterId === selectedCharacterId);
  if (!keepCurrentPage && selectedIndex >= 0) savedPage = Math.floor(selectedIndex / SAVED_PAGE_SIZE);
  savedPage = Math.max(0, Math.min(savedPage, pageCount - 1));
  pager.hidden = pageCount <= 1;
  pager.querySelector("[data-role='page-status']").textContent = `第 ${savedPage + 1} / ${pageCount} 页 · 共 ${entries.length} 张`;
  pager.querySelector("[data-role='page-previous']").disabled = savedPage === 0;
  pager.querySelector("[data-role='page-next']").disabled = savedPage === pageCount - 1;

  const pageEntries = entries.slice(savedPage * SAVED_PAGE_SIZE, (savedPage + 1) * SAVED_PAGE_SIZE);
  for (const [characterId, variant] of pageEntries) {
    const row = createElement("button", "srl-persona-variant__item");
    row.type = "button";
    row.dataset.characterId = characterId;
    row.classList.toggle("is-selected", characterId === selectedCharacterId);
    const isCurrentCharacter = characterId === currentCharacterId;
    row.classList.toggle("is-current", isCurrentCharacter);
    row.append(createElement("span", "srl-persona-variant__name", characterName(characterId)));
    if (isCurrentCharacter) row.append(createElement("small", "srl-persona-variant__current", "当前"));
    row.append(createElement("small", "", `${countPersonaVariantItems(profile, characterId)} 个版本`));
    row.addEventListener("click", () => {
      selectedCharacterId = characterId;
      selectedVersionId = getActiveVersionId(variant);
      versionsOpen = false;
      updateVariantList(panel, profile);
      renderEditor(panel, getProfile(), characterId, selectedVersionId);
    });
    list.append(row);
  }
}

function saveVariantChange(panel, profile, characterId) {
  persistProfile(profile);
  updateVariantList(panel, profile);
  updatePreview(panel, profile, characterId);
}

function renameVersion(panel, profile, characterId, versionId) {
  const variant = profile.variants[characterId];
  const version = variant?.versions?.[versionId];
  if (!version) return;
  const item = panel.querySelector(`[data-version-id="${CSS.escape(versionId)}"]`);
  if (!item) return;
  const name = item.querySelector("[data-role='version-name']");
  const input = createElement("input", "text_pole srl-persona-variant__rename-input");
  input.value = version.name;
  input.setAttribute("aria-label", "版本名称");
  name.replaceWith(input);
  const actions = item.querySelector("[data-role='version-actions']");
  actions.replaceChildren();
  const save = createElement("button", "srl-persona-variant__small-button", "保存");
  save.type = "button";
  save.addEventListener("click", () => {
    const nextName = input.value.trim();
    if (!nextName) {
      input.focus();
      return;
    }
    version.name = nextName;
    persistProfile(profile);
    renderEditor(panel, getProfile(), characterId, versionId);
  });
  const cancel = createElement("button", "srl-persona-variant__small-button", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => renderEditor(panel, getProfile(), characterId, versionId));
  actions.append(save, cancel);
  input.focus();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save.click();
    if (event.key === "Escape") cancel.click();
  });
}

function deleteVersion(panel, profile, characterId, versionId) {
  const variant = profile.variants[characterId];
  const version = variant?.versions?.[versionId];
  if (!version) return;
  const name = characterName(characterId);
  const fallbackId = variant.defaultVersionId !== versionId
    ? variant.defaultVersionId
    : Object.keys(variant.versions).find((id) => id !== versionId) || "";
  const fallbackName = fallbackId ? variant.versions[fallbackId]?.name : "全局人设";
  const confirmed = window.confirm(
    `确定删除“${version.name}”吗？“${name}”中使用此版本的聊天将改用“${fallbackName}”。此操作会删除该版本里的改写和补充。`,
  );
  if (!confirmed) return;

  delete variant.versions[versionId];
  if (variant.defaultVersionId === versionId) variant.defaultVersionId = fallbackId;
  for (const [chatId, activeId] of Object.entries(variant.chatVersions)) {
    if (activeId === versionId) {
      if (fallbackId) variant.chatVersions[chatId] = fallbackId;
      else delete variant.chatVersions[chatId];
    }
  }
  if (!Object.keys(variant.versions).length) delete profile.variants[characterId];

  if (selectedVersionId === versionId) {
    selectedVersionId = getActiveVersionId(profile.variants[characterId]);
  }
  persistProfile(profile);
  updateVariantList(panel, profile);
  renderEditor(panel, getProfile(), profile.variants[characterId] ? characterId : "", selectedVersionId);
}

function createVersion(panel, profile, characterId, sourceVersionId) {
  const variant = ensureVariant(profile, characterId);
  const source = variant.versions[sourceVersionId] || getPersonaVariantVersion(variant, getChatKey());
  const baseName = `版本 ${Object.keys(variant.versions).length + 1}`;
  const version = makeVersion(baseName, source);
  variant.versions[version.id] = version;
  variant.chatVersions[getChatKey()] = version.id;
  selectedVersionId = version.id;
  versionsOpen = true;
  persistProfile(profile);
  updateVariantList(panel, profile);
  renderEditor(panel, getProfile(), characterId, version.id);
}

function renderVersionList(panel, profile, characterId, variant, editingVersionId, chooser) {
  chooser.replaceChildren();
  const top = createElement("div", "srl-persona-variant__versions-toolbar");
  top.append(createElement("strong", "", "版本列表"));
  const add = createElement("button", "srl-persona-variant__small-button", "＋ 新建版本");
  add.type = "button";
  add.addEventListener("click", () => createVersion(panel, profile, characterId, editingVersionId));
  top.append(add);
  chooser.append(top);

  for (const version of Object.values(variant.versions)) {
    const item = createElement("div", "srl-persona-variant__version-item");
    item.dataset.versionId = version.id;
    item.classList.toggle("is-editing", version.id === editingVersionId);
    const main = createElement("div", "srl-persona-variant__version-main");
    const select = createElement("button", "srl-persona-variant__version-select");
    select.type = "button";
    select.dataset.role = "version-name";
    select.append(createElement("span", "", version.name));
    if (version.id === getActiveVersionId(variant)) {
      select.append(createElement("small", "srl-persona-variant__current", "本聊天"));
    }
    if (version.id === variant.defaultVersionId) {
      select.append(createElement("small", "srl-persona-variant__default", "默认"));
    }
    if (version.id === editingVersionId) {
      select.append(createElement("small", "srl-persona-variant__editing", "正在编辑"));
    }
    select.addEventListener("click", () => {
      variant.chatVersions[getChatKey()] = version.id;
      selectedVersionId = version.id;
      versionsOpen = true;
      persistProfile(profile);
      updateVariantList(panel, profile);
      renderEditor(panel, getProfile(), characterId, version.id);
    });

    const previewToggle = createElement("button", "srl-persona-variant__small-button", "展开");
    previewToggle.type = "button";
    previewToggle.setAttribute("aria-expanded", "false");
    const preview = createElement("div", "srl-persona-variant__version-preview");
    preview.hidden = true;
    previewToggle.addEventListener("click", () => {
      const expanded = previewToggle.getAttribute("aria-expanded") === "true";
      previewToggle.setAttribute("aria-expanded", String(!expanded));
      previewToggle.textContent = expanded ? "展开" : "收起";
      preview.hidden = expanded;
    });
    const previewProfile = {
      ...profile,
      variants: {
        ...profile.variants,
        [characterId]: { ...variant, chatVersions: { ...variant.chatVersions, [getChatKey()]: version.id } },
      },
    };
    const previewLines = resolvePersonaVariantPreview(previewProfile, characterId, getChatKey());
    if (previewLines.length) {
      previewLines.forEach((line) => preview.append(createElement("p", "", line)));
    } else {
      preview.append(createElement("p", "is-muted", "此版本当前使用完整的全局人设。"));
    }

    const actions = createElement("div", "srl-persona-variant__version-actions");
    actions.dataset.role = "version-actions";
    const rename = createElement("button", "srl-persona-variant__small-button", "重命名");
    rename.type = "button";
    rename.addEventListener("click", () => renameVersion(panel, profile, characterId, version.id));
    const setDefault = createElement("button", "srl-persona-variant__small-button", "设为默认");
    setDefault.type = "button";
    setDefault.hidden = version.id === variant.defaultVersionId;
    setDefault.addEventListener("click", () => {
      variant.defaultVersionId = version.id;
      persistProfile(profile);
      renderEditor(panel, getProfile(), characterId, editingVersionId);
    });
    const remove = createElement("button", "srl-persona-variant__small-button is-danger", "删除");
    remove.type = "button";
    remove.addEventListener("click", () => deleteVersion(panel, profile, characterId, version.id));
    actions.append(rename, setDefault, remove);
    main.append(select, previewToggle, actions);
    item.append(main, preview);
    if (version.id === editingVersionId) item.classList.add("is-editing");
    chooser.append(item);
  }
}

function renderEditor(panel, profile, characterId, requestedVersionId = "") {
  const editor = panel.querySelector("[data-role='editor']");
  editor.replaceChildren();
  if (!characterId) {
    editor.append(createElement("p", "srl-persona-variant__empty", "选择“新增”来指定角色卡并填写专属内容。"));
    return;
  }

  const character = getContext()?.characters?.find((item) => item.avatar === characterId);
  const variant = ensureVariant(profile, characterId);
  const activeVersionId = getActiveVersionId(variant);
  selectedVersionId = variant.versions[requestedVersionId] ? requestedVersionId : activeVersionId;
  const version = variant.versions[selectedVersionId] || getPersonaVariantVersion(variant, getChatKey());
  if (!version) return;

  const title = createElement("div", "srl-persona-variant__editor-heading");
  title.append(createElement("h4", "srl-persona-variant__editor-title", character?.name || characterId));
  const switchVersions = createElement("button", "srl-persona-variant__version-toggle", `版本 · ${version.name} ▾`);
  switchVersions.type = "button";
  switchVersions.setAttribute("aria-expanded", String(versionsOpen));
  title.append(switchVersions);
  editor.append(title);
  const chooser = createElement("div", "srl-persona-variant__versions");
  chooser.hidden = !versionsOpen;
  renderVersionList(panel, profile, characterId, variant, selectedVersionId, chooser);
  switchVersions.addEventListener("click", () => {
    versionsOpen = !versionsOpen;
    chooser.hidden = !versionsOpen;
    switchVersions.setAttribute("aria-expanded", String(versionsOpen));
  });
  editor.append(chooser);

  const addition = createElement("textarea", "text_pole textarea_compact");
  addition.rows = 3;
  addition.placeholder = "例如：这张角色卡下，你和角色是从小一起长大的朋友。";
  addition.value = version.addition || "";
  const additionField = createElement("label", "srl-persona-variant__field");
  additionField.append(createElement("strong", "", "新增此版本专属的补充"));
  additionField.append(createElement("small", "", "只在本聊天选择此版本时生效。"));
  additionField.append(addition);
  addition.addEventListener("input", () => {
    version.addition = addition.value;
    saveVariantChange(panel, profile, characterId);
  });
  editor.append(additionField);

  const overrides = createElement("section", "srl-persona-variant__overrides");
  overrides.append(createElement("h5", "", "只为此版本改写全局设定"));
  overrides.append(createElement("p", "srl-persona-variant__hint", "编辑框会先填入全局原文；修改只对当前版本生效。"));

  for (const section of profile.sections) {
    const existing = version.overrides?.[section.id];
    const isReplacement = existing?.mode === "replace";
    const block = createElement("div", "srl-persona-variant__override");
    block.append(createElement("strong", "", section.name || "全局设定"));
    if (section.text.trim()) {
      block.append(createElement("p", "srl-persona-variant__global", `全局内容：${section.text.trim()}`));
    }

    if (isReplacement) {
      const replacement = createElement("textarea", "text_pole textarea_compact");
      replacement.rows = 3;
      replacement.value = existing.text || section.text;
      replacement.placeholder = "填写仅对此版本生效的内容";
      const replacementLabel = createElement("label", "srl-persona-variant__field");
      replacementLabel.append(createElement("small", "", "此版本使用的内容（已填入全局原文，可直接修改）"));
      replacementLabel.append(replacement);
      replacement.addEventListener("input", () => {
        if (replacement.value.trim()) {
          version.overrides[section.id] = { mode: "replace", text: replacement.value };
        } else {
          delete version.overrides[section.id];
        }
        saveVariantChange(panel, profile, characterId);
        if (!replacement.value.trim()) renderEditor(panel, getProfile(), characterId, selectedVersionId);
      });
      block.append(replacementLabel);
      const restore = createElement("button", "srl-persona-variant__text-button", "恢复使用全局内容");
      restore.type = "button";
      restore.addEventListener("click", () => {
        const confirmed = window.confirm(
          `确定恢复使用全局内容吗？这会移除“${character?.name || characterId}”的“${version.name}”对此段的专属改写。该版本的其他补充和全局人设不会改变。`,
        );
        if (!confirmed) return;
        delete version.overrides[section.id];
        saveVariantChange(panel, profile, characterId);
        renderEditor(panel, getProfile(), characterId, selectedVersionId);
      });
      block.append(restore);
    } else {
      const begin = createElement("button", "srl-persona-variant__text-button", "改写这段全局设定");
      begin.type = "button";
      begin.addEventListener("click", () => {
        version.overrides[section.id] = { mode: "replace", text: section.text };
        renderEditor(panel, profile, characterId, selectedVersionId);
        panel.querySelector("[data-section-editor]")?.focus();
      });
      block.append(begin);
    }
    if (isReplacement) {
      block.dataset.section = section.id;
      const replacement = block.querySelector("textarea");
      if (replacement) replacement.dataset.sectionEditor = section.id;
    }
    overrides.append(block);
  }
  editor.append(overrides);

  const preview = createElement("section", "srl-persona-variant__preview");
  const toggle = createElement("button", "srl-persona-variant__preview-toggle", `查看“${version.name}”最终生效的人设`);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const content = createElement("div", "srl-persona-variant__preview-content");
  content.dataset.role = "preview";
  content.hidden = true;
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    content.hidden = expanded;
  });
  preview.append(toggle, content);
  editor.append(preview);
  updatePreview(panel, profile, characterId);
}

function openAddFlow(panel, profile) {
  const form = panel.querySelector("[data-role='add-form']");
  form.replaceChildren();
  const characters = getContext()?.characters || [];
  if (!characters.length) {
    form.append(createElement("p", "srl-persona-variant__empty", "酒馆中还没有可选的角色卡。"));
    form.hidden = false;
    return;
  }

  const select = createElement("select", "text_pole");
  select.setAttribute("aria-label", "选择要添加专属设定的角色卡");
  const first = createElement("option", "", "选择角色卡…");
  first.value = "";
  select.append(first);
  for (const character of characters) {
    const option = createElement("option", "", character.name || character.avatar);
    option.value = character.avatar;
    select.append(option);
  }
  const currentId = getCurrentCharacter()?.avatar;
  if (currentId && characters.some((character) => character.avatar === currentId)) {
    select.value = currentId;
  }

  const choose = createElement("button", "srl-persona-variant__primary", "继续编辑");
  choose.type = "button";
  choose.addEventListener("click", () => {
    if (!select.value) {
      select.focus();
      return;
    }
    selectedCharacterId = select.value;
    const variant = ensureVariant(profile, selectedCharacterId);
    selectedVersionId = getActiveVersionId(variant);
    variant.chatVersions[getChatKey()] = selectedVersionId;
    versionsOpen = false;
    form.hidden = true;
    persistProfile(profile);
    updateVariantList(panel, profile);
    renderEditor(panel, getProfile(), selectedCharacterId, selectedVersionId);
  });
  const cancel = createElement("button", "srl-persona-variant__text-button", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    form.hidden = true;
    form.replaceChildren();
  });
  const field = createElement("label", "srl-persona-variant__field");
  field.append(createElement("strong", "", "这份专属设定属于哪张角色卡？"));
  field.append(select);
  const actions = createElement("div", "srl-persona-variant__actions");
  actions.append(choose, cancel);
  form.append(field, actions);
  form.hidden = false;
}

function renderPanel() {
  const anchor = document.getElementById("persona_description");
  if (!anchor || !anchor.parentElement) return;
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = createElement("section", "srl-persona-variant");
    panel.id = PANEL_ID;
    const heading = createElement("div", "srl-persona-variant__heading");
    heading.append(createElement("h3", "", "角色卡专属设定"));
    heading.append(createElement("p", "", "上方是全局人设；这里只保存你手动添加的角色卡差异，不会改动全局内容。"));
    const status = createElement("p", "srl-persona-variant__status");
    status.dataset.role = "status";
    status.setAttribute("role", "status");

    const toolbar = createElement("div", "srl-persona-variant__toolbar");
    const add = createElement("button", "srl-persona-variant__primary", "＋ 新增角色卡专属设定");
    add.type = "button";
    toolbar.append(add);
    const addForm = createElement("div", "srl-persona-variant__add-form");
    addForm.dataset.role = "add-form";
    addForm.hidden = true;

    const list = createElement("div", "srl-persona-variant__saved-list");
    list.dataset.role = "saved-list";
    const pager = createElement("nav", "srl-persona-variant__pager");
    pager.dataset.role = "saved-pager";
    pager.setAttribute("aria-label", "角色卡补充分页");
    const previous = createElement("button", "srl-persona-variant__page-button", "上一页");
    previous.type = "button";
    previous.dataset.role = "page-previous";
    previous.addEventListener("click", () => {
      savedPage = Math.max(0, savedPage - 1);
      updateVariantList(panel, getProfile() || profile, true);
    });
    const pageStatus = createElement("span", "srl-persona-variant__page-status");
    pageStatus.dataset.role = "page-status";
    const next = createElement("button", "srl-persona-variant__page-button", "下一页");
    next.type = "button";
    next.dataset.role = "page-next";
    next.addEventListener("click", () => {
      savedPage += 1;
      updateVariantList(panel, getProfile() || profile, true);
    });
    pager.append(previous, pageStatus, next);
    const editor = createElement("div", "srl-persona-variant__editor");
    editor.dataset.role = "editor";
    const layout = createElement("div", "srl-persona-variant__layout");
    const saved = createElement("section", "srl-persona-variant__saved");
    saved.append(createElement("h4", "", "已添加的角色卡"), list, pager);
    layout.append(saved, editor);
    panel.append(heading, status, toolbar, addForm, layout);
    anchor.insertAdjacentElement("afterend", panel);
    add.addEventListener("click", () => openAddFlow(panel, getProfile() || {
      version: 1,
      sections: [{ id: "base", name: "基础设定", text: anchor.value || "" }],
      variants: {},
    }));
  }

  const profile = getProfile() || {
    version: 1,
    sections: [{ id: "base", name: "基础设定", text: anchor.value || "" }],
    variants: {},
  };
  const savedIds = Object.entries(profile.variants || {})
    .filter(([, variant]) => variantHasContent(variant))
    .map(([id]) => id);
  if (!savedIds.includes(selectedCharacterId)) selectedCharacterId = "";
  const selectedVariant = profile.variants[selectedCharacterId];
  if (selectedVariant && !selectedVariant.versions[selectedVersionId]) {
    selectedVersionId = getActiveVersionId(selectedVariant);
  }
  updateVariantList(panel, profile);
  if (selectedCharacterId) renderEditor(panel, profile, selectedCharacterId, selectedVersionId);
  else panel.querySelector("[data-role='editor']").replaceChildren(
    createElement("p", "srl-persona-variant__empty", "点击左侧已添加的角色卡进行修改，或使用上方“新增”创建专属设定。"),
  );
  refreshPersonaVariantPrompt();
}

export function startPersonaVariantManager() {
  const refresh = () => {
    try {
      renderPanel();
    } catch (error) {
      console.warn("SRL Bridge: 无法显示角色卡专属设定", error);
    }
  };
  refresh();
  document.addEventListener("input", (event) => {
    if (event.target?.id === "persona_description") refresh();
  });
  for (const event of [
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.CHAT_LOADED,
    event_types.PERSONA_CHANGED,
    event_types.CHARACTER_PAGE_LOADED,
  ]) {
    eventSource.on(event, () => {
      if (event === event_types.CHAT_CHANGED) {
        selectedCharacterId = getCurrentCharacter()?.avatar || "";
        selectedVersionId = "";
        versionsOpen = false;
        savedPage = 0;
      }
      refresh();
    });
  }
}
