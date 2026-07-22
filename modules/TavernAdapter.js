import { MAX_FILE_SIZE, RESOURCE_KINDS, safeFileName, uniqueName } from './Protocol.js'

function assertResponse(response, action) {
  if (response.ok) return response
  throw new Error(`${action}失败（HTTP ${response.status}）`)
}

function jsonFile(data, name) {
  return new File([JSON.stringify(data, null, 2)], `${safeFileName(name)}.json`, {
    type: 'application/json',
  })
}

function displayNameFromFile(file, fallback) {
  return safeFileName(file.name.replace(/\.[^.]+$/u, ''), fallback)
}

export class TavernAdapter {
  get context() {
    const context = window.SillyTavern?.getContext?.()
    if (!context) throw new Error('SillyTavern 上下文尚未准备好')
    return context
  }

  async listResources() {
    const context = this.context
    const characters = context.characters.map((character) => ({
      id: `character:${character.avatar}`,
      kind: RESOURCE_KINDS.CHARACTER,
      name: character.name || character.avatar.replace(/\.png$/i, ''),
      fileName: character.avatar,
      detail: character.data?.creator || character.creator || '',
    }))
    const worldBooks = context.getWorldInfoNames().map((name) => ({
      id: `worldBook:${name}`,
      kind: RESOURCE_KINDS.WORLD_BOOK,
      name,
      fileName: `${name}.json`,
      detail: '世界书',
    }))
    const presetManager = await context.getPresetManager()
    const presetNames = (await presetManager?.getAllPresets?.()) ?? []
    const presets = presetNames.map((name) => ({
      id: `preset:${name}`,
      kind: RESOURCE_KINDS.PRESET,
      name,
      fileName: `${name}.json`,
      detail: '当前 API 类型的预设',
    }))
    const globalRegexes = (
      Array.isArray(context.extensionSettings?.regex) ? context.extensionSettings.regex : []
    ).map((script, index) => ({
      id: `regexGlobal:${script.id || index}`,
      kind: RESOURCE_KINDS.REGEX_GLOBAL,
      name: script.scriptName || `正则 ${index + 1}`,
      fileName: `${safeFileName(script.scriptName || `regex-${index + 1}`)}.json`,
      detail: '全局正则',
    }))
    const characterRegexes = context.characters.flatMap((character) => {
      const scripts = character.data?.extensions?.regex_scripts
      if (!Array.isArray(scripts) || !scripts.length) return []
      const name = character.name || character.avatar.replace(/\.png$/i, '')
      return [
        {
          id: `regexCharacter:${character.avatar}`,
          kind: RESOURCE_KINDS.REGEX_CHARACTER,
          name: `${name} · 角色卡正则`,
          fileName: `${safeFileName(name)} · 角色卡正则.json`,
          detail: `${scripts.length} 条 · 绑定角色卡`,
        },
      ]
    })
    const presetRegexes = (
      await Promise.all(
        presets.map(async (preset) => {
          const data = await presetManager?.getCompletionPresetByName?.(preset.name)
          const scripts = data?.extensions?.regex_scripts
          if (!Array.isArray(scripts) || !scripts.length) return undefined
          return {
            id: `regexPreset:${preset.name}`,
            kind: RESOURCE_KINDS.REGEX_PRESET,
            name: `${preset.name} · 预设正则`,
            fileName: `${safeFileName(preset.name)} · 预设正则.json`,
            detail: `${scripts.length} 条 · 绑定预设`,
          }
        }),
      )
    ).filter(Boolean)
    const quickReplyApi = globalThis.quickReplyApi
    const quickReplies = quickReplyApi
      ? quickReplyApi.listSets().map((name) => ({
          id: `quickReply:${name}`,
          kind: RESOURCE_KINDS.QUICK_REPLY,
          name,
          fileName: `${safeFileName(name)}.json`,
          detail: '快速回复组',
        }))
      : []
    let themes = []
    try {
      themes =
        (await this.getSettingsData()).themes?.map((theme) => ({
          id: `theme:${theme.name}`,
          kind: RESOURCE_KINDS.THEME,
          name: theme.name,
          fileName: `${safeFileName(theme.name)}.json`,
          detail: '酒馆主题',
        })) ?? []
    } catch {
      // Older SillyTavern builds may not expose themes in settings/get.
    }
    return [
      ...characters,
      ...worldBooks,
      ...presets,
      ...globalRegexes,
      ...characterRegexes,
      ...presetRegexes,
      ...quickReplies,
      ...themes,
    ]
  }

  async getSettingsData() {
    const response = assertResponse(
      await fetch('/api/settings/get', {
        method: 'POST',
        headers: this.context.getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
      }),
      '读取酒馆设置',
    )
    return response.json()
  }

  async exportResource(item) {
    const context = this.context
    if (item.kind === RESOURCE_KINDS.CHARACTER) {
      const avatar = item.id.slice('character:'.length)
      const response = assertResponse(
        await fetch('/api/characters/export', {
          method: 'POST',
          headers: context.getRequestHeaders(),
          body: JSON.stringify({ format: 'png', avatar_url: avatar }),
        }),
        '导出角色卡',
      )
      return new File([await response.blob()], avatar, { type: 'image/png' })
    }
    if (item.kind === RESOURCE_KINDS.WORLD_BOOK) {
      const name = item.id.slice('worldBook:'.length)
      const response = assertResponse(
        await fetch('/api/worldinfo/get', {
          method: 'POST',
          headers: context.getRequestHeaders(),
          body: JSON.stringify({ name }),
          cache: 'no-cache',
        }),
        '导出世界书',
      )
      return jsonFile(await response.json(), name)
    }
    if (item.kind === RESOURCE_KINDS.PRESET) {
      const name = item.id.slice('preset:'.length)
      const manager = await context.getPresetManager()
      const preset = await manager?.getCompletionPresetByName?.(name)
      if (!preset) throw new Error(`找不到预设“${name}”`)
      return jsonFile(preset, name)
    }
    if (item.kind === RESOURCE_KINDS.REGEX_GLOBAL) {
      const key = item.id.slice('regexGlobal:'.length)
      const scripts = Array.isArray(context.extensionSettings?.regex)
        ? context.extensionSettings.regex
        : []
      const script = scripts.find((entry, index) => String(entry.id || index) === key)
      if (!script) throw new Error(`找不到正则“${item.name}”`)
      return jsonFile({ global: [script], sourceName: '全局正则' }, script.scriptName || item.name)
    }
    if (item.kind === RESOURCE_KINDS.REGEX_CHARACTER) {
      const avatar = item.id.slice('regexCharacter:'.length)
      const character = context.characters.find((entry) => entry.avatar === avatar)
      const scripts = character?.data?.extensions?.regex_scripts
      if (!character || !Array.isArray(scripts)) throw new Error(`找不到角色卡正则“${item.name}”`)
      return jsonFile(
        {
          scoped: scripts,
          sourceName: character.name || avatar,
          sourceAvatar: avatar,
        },
        item.fileName.replace(/\.json$/i, ''),
      )
    }
    if (item.kind === RESOURCE_KINDS.REGEX_PRESET) {
      const name = item.id.slice('regexPreset:'.length)
      const manager = await context.getPresetManager()
      const preset = await manager?.getCompletionPresetByName?.(name)
      const scripts = preset?.extensions?.regex_scripts
      if (!preset || !Array.isArray(scripts)) throw new Error(`找不到预设正则“${item.name}”`)
      return jsonFile({ preset: scripts, sourceName: name }, item.fileName.replace(/\.json$/i, ''))
    }
    if (item.kind === RESOURCE_KINDS.QUICK_REPLY) {
      const name = item.id.slice('quickReply:'.length)
      const set = globalThis.quickReplyApi?.getSetByName(name)
      if (!set) throw new Error(`找不到快速回复组“${name}”`)
      return jsonFile(set.toJSON(), name)
    }
    if (item.kind === RESOURCE_KINDS.THEME) {
      const name = item.id.slice('theme:'.length)
      const theme = (await this.getSettingsData()).themes?.find((entry) => entry.name === name)
      if (!theme) throw new Error(`找不到主题“${name}”`)
      return jsonFile(theme, name)
    }
    throw new Error('暂不支持这种资源类型')
  }

  async importResource(file, kind, conflictPolicy = 'copy', metadata = {}) {
    if (file.size > MAX_FILE_SIZE) throw new Error('单个文件超过 256 MB，已停止导入')
    if (kind === RESOURCE_KINDS.CHARACTER) return this.importCharacter(file, conflictPolicy)
    if (kind === RESOURCE_KINDS.WORLD_BOOK) return this.importWorldBook(file, conflictPolicy)
    if (kind === RESOURCE_KINDS.PRESET) return this.importPreset(file, conflictPolicy)
    if (kind === RESOURCE_KINDS.REGEX_GLOBAL) return this.importRegex(file, conflictPolicy)
    if (kind === RESOURCE_KINDS.REGEX_CHARACTER) {
      return this.importScopedRegex(file, conflictPolicy, metadata.targetName)
    }
    if (kind === RESOURCE_KINDS.REGEX_PRESET) {
      return this.importPresetRegex(file, conflictPolicy, metadata.targetName)
    }
    if (kind === RESOURCE_KINDS.QUICK_REPLY) return this.importQuickReply(file, conflictPolicy)
    if (kind === RESOURCE_KINDS.THEME) return this.importTheme(file, conflictPolicy)
    throw new Error('酒馆端暂不支持这种资源类型')
  }

  async importCharacter(file, conflictPolicy) {
    const context = this.context
    const baseName = file.name.replace(/\.[^.]+$/u, '')
    const existing = context.characters.find(
      (character) =>
        character.name?.toLocaleLowerCase() === baseName.toLocaleLowerCase() ||
        character.avatar?.replace(/\.png$/i, '').toLocaleLowerCase() ===
          baseName.toLocaleLowerCase(),
    )
    if (existing && conflictPolicy === 'skip') return { status: 'skipped', name: baseName }
    const format = file.name.split('.').pop()?.toLocaleLowerCase()
    if (!format || !['png', 'json'].includes(format)) throw new Error('角色卡只支持 PNG 或 JSON')
    const form = new FormData()
    form.append('avatar', file)
    form.append('file_type', format)
    form.append('user_name', context.name1)
    if (existing && conflictPolicy === 'overwrite') form.append('preserved_name', existing.avatar)
    const response = assertResponse(
      await fetch('/api/characters/import', {
        method: 'POST',
        body: form,
        headers: context.getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
      }),
      '导入角色卡',
    )
    const result = await response.json()
    if (result.error) throw new Error('酒馆拒绝了角色卡文件')
    await context.getCharacters?.()
    return {
      status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created',
      name: result.file_name,
    }
  }

  async importWorldBook(file, conflictPolicy) {
    const context = this.context
    const parsed = JSON.parse(await file.text())
    if (!parsed || typeof parsed !== 'object' || !('entries' in parsed)) {
      throw new Error('世界书缺少 entries')
    }
    const baseName = safeFileName(file.name.replace(/\.[^.]+$/u, ''), 'SRL 世界书')
    const names = context.getWorldInfoNames()
    const existing = names.find((name) => name.toLocaleLowerCase() === baseName.toLocaleLowerCase())
    if (existing && conflictPolicy === 'skip') return { status: 'skipped', name: existing }
    const targetName =
      existing && conflictPolicy === 'copy' ? uniqueName(baseName, names) : baseName
    const targetFile = new File([JSON.stringify(parsed)], `${targetName}.json`, {
      type: 'application/json',
    })
    const form = new FormData()
    form.append('avatar', targetFile)
    const response = assertResponse(
      await fetch('/api/worldinfo/import', {
        method: 'POST',
        headers: context.getRequestHeaders({ omitContentType: true }),
        body: form,
        cache: 'no-cache',
      }),
      '导入世界书',
    )
    const result = await response.json()
    await context.updateWorldInfoList?.()
    return {
      status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created',
      name: result.name,
    }
  }

  async importPreset(file, conflictPolicy) {
    const context = this.context
    const preset = JSON.parse(await file.text())
    const manager = await context.getPresetManager()
    if (!manager) throw new Error('当前酒馆没有可用的预设管理器')
    const names = (await manager.getAllPresets?.()) ?? []
    const baseName = safeFileName(file.name.replace(/\.[^.]+$/u, ''), 'SRL 预设')
    const existing = names.find((name) => name.toLocaleLowerCase() === baseName.toLocaleLowerCase())
    if (existing && conflictPolicy === 'skip') return { status: 'skipped', name: existing }
    const targetName =
      existing && conflictPolicy === 'copy' ? uniqueName(baseName, names) : baseName
    await manager.savePreset(targetName, preset)
    return {
      status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created',
      name: targetName,
    }
  }

  async importRegex(file, conflictPolicy) {
    const parsed = JSON.parse(await file.text())
    const incoming = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.global)
        ? parsed.global
        : [parsed]
    if (!incoming.length || incoming.some((script) => !script || typeof script !== 'object')) {
      throw new Error('正则文件内容无效')
    }
    const scripts = Array.isArray(this.context.extensionSettings?.regex)
      ? [...this.context.extensionSettings.regex]
      : []
    let skipped = 0
    for (const source of incoming) {
      const script = structuredClone(source)
      const baseName = safeFileName(script.scriptName || displayNameFromFile(file, 'SRL 正则'))
      const existingIndex = scripts.findIndex(
        (entry) =>
          (script.id && entry.id === script.id) ||
          entry.scriptName?.toLocaleLowerCase() === baseName.toLocaleLowerCase(),
      )
      if (existingIndex >= 0 && conflictPolicy === 'skip') {
        skipped += 1
        continue
      }
      if (existingIndex >= 0 && conflictPolicy === 'copy') {
        script.id = crypto.randomUUID()
        script.scriptName = uniqueName(
          baseName,
          scripts.map((entry) => entry.scriptName || ''),
        )
        scripts.push(script)
      } else if (existingIndex >= 0) {
        script.scriptName = baseName
        scripts.splice(existingIndex, 1, script)
      } else {
        script.id ||= crypto.randomUUID()
        script.scriptName = baseName
        scripts.push(script)
      }
    }
    this.context.extensionSettings.regex = scripts
    this.context.saveSettingsDebounced()
    return {
      status: skipped === incoming.length ? 'skipped' : 'created',
      name:
        incoming.length === 1 ? incoming[0].scriptName || file.name : `${incoming.length} 条正则`,
    }
  }

  async importScopedRegex(file, conflictPolicy, requestedName) {
    const parsed = JSON.parse(await file.text())
    const incoming = Array.isArray(parsed) ? parsed : parsed.scoped
    if (!Array.isArray(incoming) || !incoming.length) throw new Error('角色卡正则文件为空')
    const targetName = requestedName || parsed.sourceName
    const index = this.context.characters.findIndex(
      (character) =>
        character.name?.toLocaleLowerCase() === String(targetName).toLocaleLowerCase() ||
        character.avatar === parsed.sourceAvatar,
    )
    if (index < 0) throw new Error(`酒馆中找不到目标角色卡“${targetName || '未指定'}”`)
    const character = this.context.characters[index]
    const existing = Array.isArray(character.data?.extensions?.regex_scripts)
      ? character.data.extensions.regex_scripts
      : []
    if (existing.length && conflictPolicy === 'skip')
      return { status: 'skipped', name: character.name }
    const scripts = conflictPolicy === 'copy' ? this.mergeRegexCopies(existing, incoming) : incoming
    await this.context.writeExtensionField(index, 'regex_scripts', scripts)
    return {
      status: existing.length && conflictPolicy === 'overwrite' ? 'overwritten' : 'created',
      name: character.name,
    }
  }

  async importPresetRegex(file, conflictPolicy, requestedName) {
    const parsed = JSON.parse(await file.text())
    const incoming = Array.isArray(parsed) ? parsed : parsed.preset
    if (!Array.isArray(incoming) || !incoming.length) throw new Error('预设正则文件为空')
    const targetName = requestedName || parsed.sourceName
    const manager = await this.context.getPresetManager()
    const names = (await manager?.getAllPresets?.()) ?? []
    const actualName = names.find(
      (name) => name.toLocaleLowerCase() === String(targetName).toLocaleLowerCase(),
    )
    if (!actualName) throw new Error(`酒馆中找不到目标预设“${targetName || '未指定'}”`)
    const preset = await manager.getCompletionPresetByName(actualName)
    const existing = Array.isArray(preset?.extensions?.regex_scripts)
      ? preset.extensions.regex_scripts
      : []
    if (existing.length && conflictPolicy === 'skip') return { status: 'skipped', name: actualName }
    const scripts = conflictPolicy === 'copy' ? this.mergeRegexCopies(existing, incoming) : incoming
    await manager.writePresetExtensionField({
      name: actualName,
      path: 'regex_scripts',
      value: scripts,
    })
    return {
      status: existing.length && conflictPolicy === 'overwrite' ? 'overwritten' : 'created',
      name: actualName,
    }
  }

  mergeRegexCopies(existing, incoming) {
    const result = [...existing]
    for (const source of incoming) {
      const script = structuredClone(source)
      const baseName = safeFileName(script.scriptName || script.script_name || 'SRL 正则')
      script.id = crypto.randomUUID()
      script.scriptName = uniqueName(
        baseName,
        result.map((entry) => entry.scriptName || entry.script_name || ''),
      )
      result.push(script)
    }
    return result
  }

  async importQuickReply(file, conflictPolicy) {
    const api = globalThis.quickReplyApi
    if (!api) throw new Error('快速回复模块尚未加载，请稍后重试')
    const parsed = JSON.parse(await file.text())
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.qrList)) {
      throw new Error('快速回复文件缺少 qrList')
    }
    const baseName = safeFileName(parsed.name || displayNameFromFile(file, 'SRL 快速回复'))
    const names = api.listSets()
    const existing = names.find((name) => name.toLocaleLowerCase() === baseName.toLocaleLowerCase())
    if (existing && conflictPolicy === 'skip') return { status: 'skipped', name: existing }
    const targetName =
      existing && conflictPolicy === 'copy' ? uniqueName(baseName, names) : baseName
    const set = await api.createSet(targetName, {
      disableSend: parsed.disableSend,
      placeBeforeInput: parsed.placeBeforeInput,
      injectInput: parsed.injectInput,
    })
    set.color = typeof parsed.color === 'string' ? parsed.color : 'transparent'
    set.onlyBorderColor = Boolean(parsed.onlyBorderColor)
    set.qrList.splice(0)
    for (const quickReply of parsed.qrList) set.addQuickReply(structuredClone(quickReply))
    await set.save()
    return {
      status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created',
      name: targetName,
    }
  }

  async importTheme(file, conflictPolicy) {
    const parsed = JSON.parse(await file.text())
    if (!parsed || typeof parsed !== 'object') throw new Error('主题文件内容无效')
    const themes = (await this.getSettingsData()).themes ?? []
    const baseName = safeFileName(parsed.name || displayNameFromFile(file, 'SRL 主题'))
    const existing = themes.find(
      (theme) => theme.name?.toLocaleLowerCase() === baseName.toLocaleLowerCase(),
    )
    if (existing && conflictPolicy === 'skip') return { status: 'skipped', name: existing.name }
    const targetName =
      existing && conflictPolicy === 'copy'
        ? uniqueName(
            baseName,
            themes.map((theme) => theme.name),
          )
        : baseName
    const response = await fetch('/api/themes/save', {
      method: 'POST',
      headers: this.context.getRequestHeaders(),
      body: JSON.stringify({ ...parsed, name: targetName }),
    })
    assertResponse(response, '导入主题')
    return {
      status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created',
      name: targetName,
    }
  }
}
