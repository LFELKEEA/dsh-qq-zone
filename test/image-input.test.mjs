import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadImage, mimeFromPath, ImageInputError } from '../lib/image-input.js'

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7wH0AAAAAElFTkSuQmCC'

test('mimeFromPath 认常见扩展名', () => {
  assert.equal(mimeFromPath('a.PNG'), 'image/png')
  assert.equal(mimeFromPath('a.webp'), 'image/webp')
  assert.equal(mimeFromPath('a.jpg'), 'image/jpeg')
  assert.equal(mimeFromPath('a.unknown'), 'image/jpeg')
})

test('loadImage 支持本地路径并嗅探 mime', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-zone-img-'))
  const file = path.join(dir, 'x.png')
  fs.writeFileSync(file, Buffer.from(PNG_B64, 'base64'))
  const img = await loadImage({ image: file })
  assert.equal(img.mimeType, 'image/png')
  assert.equal(img.buffer.length > 0, true)
  assert.equal(img.source, file)
})

test('loadImage 支持 data URL 与 base64://', async () => {
  const dataUrl = await loadImage({ image: `data:image/png;base64,${PNG_B64}` })
  assert.equal(dataUrl.mimeType, 'image/png')
  const base64 = await loadImage({ image: `base64://${PNG_B64}` })
  assert.equal(base64.source, 'base64')
  assert.equal(base64.buffer.length > 0, true)
})

test('loadImage 支持 file:///D:/... 三斜杠写法', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-zone-img-'))
  const file = path.join(dir, 'y.png')
  fs.writeFileSync(file, Buffer.from(PNG_B64, 'base64'))
  const url = `file:///${file.replace(/\\/g, '/')}`
  const img = await loadImage({ image: url })
  assert.equal(img.mimeType, 'image/png')
})

test('loadImage 找不到文件时给出可行动的 code', async () => {
  await assert.rejects(() => loadImage({ image: 'Z:/definitely/not/here.png' }), (error) => {
    assert.ok(error instanceof ImageInputError)
    assert.equal(error.code, 'image-file-missing')
    return true
  })
})

test('loadImage 没给参数时提示该传什么', async () => {
  await assert.rejects(() => loadImage({}), (error) => {
    assert.equal(error.code, 'image-missing')
    assert.match(error.hint, /messageId/)
    return true
  })
})

test('sha256 附件 id 走 DSH 附件目录', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-zone-home-'))
  const hash = 'a'.repeat(64)
  const dir = path.join(home, 'attachments', 'v1', 'objects', 'aa')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, hash), Buffer.from(PNG_B64, 'base64'))
  const img = await loadImage({ image: `sha256:${hash}`, env: { DSH_HOME: home } })
  assert.equal(img.mimeType, 'image/png')

  await assert.rejects(() => loadImage({ image: `sha256:${'b'.repeat(64)}`, env: { DSH_HOME: home } }), (error) => {
    assert.equal(error.code, 'image-attachment-missing')
    return true
  })
})