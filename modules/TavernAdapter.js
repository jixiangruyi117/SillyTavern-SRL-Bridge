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
    return [...characters, ...worldBooks, ...presets]
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
    throw new Error('暂不支持这种资源类型')
  }

  async importResource(file, kind, conflictPolicy = 'copy') {
    if (file.size > MAX_FILE_SIZE) throw new Error('单个文件超过 256 MB，已停止导入')
    if (kind === RESOURCE_KINDS.CHARACTER) return this.importCharacter(file, conflictPolicy)
    if (kind === RESOURCE_KINDS.WORLD_BOOK) return this.importWorldBook(file, conflictPolicy)
    if (kind === RESOURCE_KINDS.PRESET) return this.importPreset(file, conflictPolicy)
    throw new Error('酒馆端暂不支持这种资源类型')
  }

  async importCharacter(file, conflictPolicy) {
    const context = this.context
    const baseName = file.name.replace(/\.[^.]+$/u, '')
    const existing = context.characters.find(
      (character) =>
        character.name?.toLocaleLowerCase() === baseName.toLocaleLowerCase() ||
        character.avatar?.replace(/\.png$/i, '').toLocaleLowerCase() === baseName.toLocaleLowerCase(),
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
    return { status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created', name: result.file_name }
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
    const targetName = existing && conflictPolicy === 'copy' ? uniqueName(baseName, names) : baseName
    const targetFile = new File([JSON.stringify(parsed)], `${targetName}.json`, { type: 'application/json' })
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
    return { status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created', name: result.name }
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
    const targetName = existing && conflictPolicy === 'copy' ? uniqueName(baseName, names) : baseName
    await manager.savePreset(targetName, preset)
    return { status: existing && conflictPolicy === 'overwrite' ? 'overwritten' : 'created', name: targetName }
  }
}
