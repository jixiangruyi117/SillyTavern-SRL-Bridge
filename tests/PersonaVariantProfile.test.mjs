import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPersonaVariantPrompt,
  normalizePersonaVariantProfile,
  resolvePersonaVariantPreview,
} from "../modules/PersonaVariantProfile.js";

test("builds only the active character's explicit replacements and additions", () => {
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

  const alice = buildPersonaVariantPrompt(profile, "alice.png");
  assert.match(alice, /年龄：本角色卡下改为“30岁”/);
  assert.match(alice, /职业：本角色卡下不采用/);
  assert.match(alice, /与 Alice 是多年好友/);
  assert.doesNotMatch(alice, /身份|全局身份|与 Bob/);
  assert.match(buildPersonaVariantPrompt(profile, "bob.png"), /与 Bob 初次见面/);
  assert.equal(buildPersonaVariantPrompt(profile, "unknown.png"), "");
});

test("ignores malformed profile data", () => {
  assert.equal(buildPersonaVariantPrompt({}, "alice.png"), "");
  assert.equal(
    buildPersonaVariantPrompt(
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

  assert.match(buildPersonaVariantPrompt(profile, "alice.png", "chatA"), /成年后的用户设定/);
  assert.match(buildPersonaVariantPrompt(profile, "alice.png", "chatB"), /校园中的用户设定/);
  assert.match(buildPersonaVariantPrompt(profile, "alice.png", "unknown-chat"), /校园中的用户设定/);
  assert.doesNotMatch(buildPersonaVariantPrompt(profile, "alice.png", "chatA"), /校园中的用户设定/);
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
