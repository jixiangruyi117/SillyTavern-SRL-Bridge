import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizePersonaVariantProfile, getPersonaVariantVersion, resolvePersonaVariantPrompt } from '../modules/PersonaVariantProfile.js';

test('entry starts persona runtime and generation uses only the active character version, then restores global persona', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /import\s*\{[^}]*startPersonaVariantRuntime[^}]*\}\s*from\s*["']\.\/modules\/PersonaVariantRuntime/s);
  assert.match(entry, /^startPersonaVariantRuntime\(\);/m);
  const source = await readFile(new URL('../modules/PersonaVariantRuntime.js', import.meta.url), 'utf8');
  const handlers = new Map();
  const power_user = {
    persona_description: '全局人设',
    persona_descriptions: { 'user.png': {
      description: '全局人设',
      srl_persona_profile: {
        version: 1,
        sections: [{ id: 'base', name: '基础', text: '全局人设' }],
        variants: { 'alice.png': {
          versions: {
            default: { overrides: {}, addition: '默认补充' },
            selected: { overrides: { base: { mode: 'replace', text: '专属人设' } }, addition: '当前聊天补充' },
          },
          defaultVersionId: 'default', chatVersions: { chatA: 'selected' },
        } },
      },
    } },
  };
  const context = { characters: [{ avatar: 'alice.png' }, { avatar: 'bob.png' }], characterId: 0, setExtensionPrompt() {} };
  const sandbox = vm.createContext({
    power_user, user_avatar: 'user.png',
    window: { SillyTavern: { getContext: () => context } },
    document: { querySelector: () => null }, console,
    event_types: Object.fromEntries(['APP_READY', 'CHAT_CHANGED', 'CHAT_LOADED', 'PERSONA_CHANGED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED'].map(key => [key, key])),
    eventSource: { on: (event, handler) => handlers.set(event, handler) },
    extension_prompt_types: { IN_PROMPT: 0 }, getCurrentChatId: () => 'chatA',
    normalizePersonaVariantProfile, getPersonaVariantVersion, resolvePersonaVariantPrompt,
  });
  vm.runInContext(source.replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, ''), sandbox);
  sandbox.startPersonaVariantRuntime();
  const generate = handlers.get('GENERATION_AFTER_COMMANDS');
  const end = handlers.get('GENERATION_ENDED');
  assert.equal(typeof generate, 'function');
  generate();
  assert.equal(power_user.persona_description, '专属人设\n当前聊天补充');
  assert.equal(power_user.persona_descriptions['user.png'].description, '全局人设');
  end();
  assert.equal(power_user.persona_description, '全局人设');
  context.characterId = 1;
  generate();
  assert.equal(power_user.persona_description, '全局人设');
  context.characterId = 0;
  generate();
  power_user.persona_description = '生成期间手动修改';
  end();
  assert.equal(power_user.persona_description, '生成期间手动修改');
});
