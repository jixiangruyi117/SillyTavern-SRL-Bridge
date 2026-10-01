import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePersonaVariantProfile,
  resolvePersonaVariantPrompt,
  resolvePersonaVariantPreview,
} from "../modules/PersonaVariantProfile.js";

test("resolves the complete active persona with replacements, disabled sections, and additions", () => {
  const profile = {
    version: 1,
    sections: [
      { id: "identity", name: "身份", text: "全局身份" },
      { id: "age", name: "年龄", text: "20岁" },
      { id: "job", name: "职业", text: "画家" },
    ],
    variants: {
      "alice.png": {
        overrides: {
          age: { mode: "replace", text: "30岁" },
          job: { mode: "disable" },
        },
        addition: "与 Alice 是多年好友。",
      },
      "bob.png": { overrides: {}, addition: "与 Bob 初次见面。" },
    },
  };

  const alice = resolvePersonaVariantPrompt(profile, "alice.png");
  assert.match(alice, /全局身份/);
  assert.match(alice, /30岁/);
  assert.doesNotMatch(alice, /20岁|画家/);
  assert.match(alice, /与 Alice 是多年好友/);
  assert.doesNotMatch(alice, /与 Bob|覆盖全局设定|用户人设调整/);
  assert.match(resolvePersonaVariantPrompt(profile, "bob.png"), /全局身份[\s\S]*20岁[\s\S]*画家[\s\S]*与 Bob 初次见面/);
  assert.equal(resolvePersonaVariantPrompt(profile, "unknown.png"), "");
});

test("ignores malformed profile data", () => {
  assert.equal(resolvePersonaVariantPrompt({}, "alice.png"), "");
  assert.equal(
    resolvePersonaVariantPrompt(
      { version: 1, sections: [], variants: { "alice.png": { addition: "  " } } },
      "alice.png",
    ),
    "",
  );
});

test("keeps the base section synchronized with the global persona description", () => {
  const profile = normalizePersonaVariantProfile(
    {
      version: 1,
      sections: [{ id: "base", name: "基础设定", text: "过期的空内容" }],
      variants: { "alice.png": { overrides: {}, addition: "Alice 专属补充" } },
    },
    "全局用户设定描述",
  );

  assert.equal(profile.sections[0].text, "全局用户设定描述");
  assert.equal(Object.values(profile.variants["alice.png"].versions)[0].addition, "Alice 专属补充");
});

test("allows clearing the global persona description in the base section", () => {
  const profile = normalizePersonaVariantProfile(
    {
      version: 1,
      sections: [{ id: "base", name: "基础设定", text: "旧全局描述" }],
      variants: {},
    },
    "",
  );

  assert.equal(profile.sections[0].text, "");
});

test("migrates a character's existing settings into a default version", () => {
  const profile = normalizePersonaVariantProfile({
    version: 1,
    sections: [{ id: "base", name: "基础设定", text: "全局" }],
    variants: {
      "alice.png": {
        overrides: { base: { mode: "replace", text: "旧角色改写" } },
        addition: "旧角色补充",
      },
    },
  }, "全局");

  const variant = profile.variants["alice.png"];
  const version = variant.versions[variant.defaultVersionId];
  assert.equal(version.name, "默认版本");
  assert.equal(version.overrides.base.text, "旧角色改写");
  assert.equal(version.addition, "旧角色补充");
});

test("selects a different character version for each chat", () => {
  const profile = {
    version: 1,
    sections: [{ id: "base", name: "基础设定", text: "全局" }],
    variants: {
      "alice.png": {
        defaultVersionId: "school",
        chatVersions: { chatA: "adult", chatB: "school" },
        versions: {
          school: { name: "校园时期", overrides: {}, addition: "校园中的用户设定" },
          adult: { name: "成年后", overrides: {}, addition: "成年后的用户设定" },
        },
      },
    },
  };

  assert.match(resolvePersonaVariantPrompt(profile, "alice.png", "chatA"), /全局[\s\S]*成年后的用户设定/);
  assert.match(resolvePersonaVariantPrompt(profile, "alice.png", "chatB"), /全局[\s\S]*校园中的用户设定/);
  assert.match(resolvePersonaVariantPrompt(profile, "alice.png", "unknown-chat"), /全局[\s\S]*校园中的用户设定/);
  assert.doesNotMatch(resolvePersonaVariantPrompt(profile, "alice.png", "chatA"), /校园中的用户设定/);
});

test("an override replaces its section and an addition appends to the final persona", () => {
  const profile = {
    version: 1,
    sections: [
      { id: "base", name: "基础设定", text: "全局人设" },
      { id: "voice", name: "说话方式", text: "全局说话方式" },
    ],
    variants: {
      "alice.png": {
        overrides: { voice: { mode: "replace", text: "只对 Alice 生效的说话方式" } },
        addition: "Alice 专属补充",
      },
    },
  };

  assert.equal(
    resolvePersonaVariantPrompt(profile, "alice.png"),
    "全局人设\n只对 Alice 生效的说话方式\nAlice 专属补充",
  );
});

test("uses updated global content unless that section has a character-specific replacement", () => {
  const profile = {
    version: 1,
    sections: [
      { id: "base", name: "基础设定", text: "我不是人" },
      { id: "voice", name: "说话方式", text: "轻声说话" },
    ],
    variants: {
      "alice.png": {
        overrides: { voice: { mode: "replace", text: "大声说话" } },
        addition: "普通人",
      },
    },
  };

  assert.equal(
    resolvePersonaVariantPrompt(profile, "alice.png"),
    "我不是人\n大声说话\n普通人",
  );
});

test("previews the latest global text alongside a version-specific override", () => {
  const profile = normalizePersonaVariantProfile({
    version: 1,
    sections: [{ id: "base", name: "基础设定", text: "旧全局内容" }],
    variants: {
      "alice.png": {
        overrides: { base: { mode: "replace", text: "此版本的专属内容" } },
        addition: "额外补充",
      },
    },
  }, "更新后的全局内容");

  assert.deepEqual(resolvePersonaVariantPreview(profile, "alice.png"), [
    "基础设定（当前全局内容，未用于此版本）",
    "更新后的全局内容",
    "基础设定（此版本实际生效）",
    "此版本的专属内容",
    "仅对此角色追加",
    "额外补充",
  ]);
});
