import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../lib/index.js'

function fakeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      effect(factory) {
        const dispose = factory()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {
            const index = registered.indexOf(definition)
            if (index >= 0) registered.splice(index, 1)
          }
        },
      },
    },
  }
}

test('插件身份：名字与依赖的注入服务', () => {
  assert.equal(name, 'dsh-qq-zone')
  assert.deepEqual(inject, ['tools'])
})

test('注册 8 个工具，且每个都有描述、参数 schema 和 execute', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx)
  const names = registered.map((item) => item.name).sort()
  assert.deepEqual(names, [
    'qzone_comment',
    'qzone_delete',
    'qzone_like',
    'qzone_profile',
    'qzone_publish',
    'qzone_timeline',
    'see_image',
    'vision_status',
  ])
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 8, `${tool.name} 描述太短`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    const rendered = tool.output.render({}, 'hello')
    assert.deepEqual(rendered, [{ type: 'text', text: 'hello' }])
  }
})

test('qzone_publish 缺内容时把错误变成可读文本（不抛异常）', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx)
  const publish = registered.find((item) => item.name === 'qzone_publish')
  const text = await publish.execute({ content: '   ' }, {})
  assert.match(text, /❌/)
  assert.match(text, /qzone-empty-content/)
})

test('qzone_publish 非法可见范围时提示可用取值', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx)
  const publish = registered.find((item) => item.name === 'qzone_publish')
  const text = await publish.execute({ content: 'hi', permission: 'everyone-i-know' }, {})
  assert.match(text, /qzone-bad-permission/)
  assert.match(text, /public/)
})

test('部分好友可见但没给 targetUins 时报错而不是静默发布', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx)
  const publish = registered.find((item) => item.name === 'qzone_publish')
  const text = await publish.execute({ content: 'hi', permission: 'some' }, {})
  assert.match(text, /qzone-missing-target-uins/)
})