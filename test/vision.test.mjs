import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { pickVisionModel, describeImage, VisionError } from '../lib/vision.js'

const MODELS = {
  object: 'list',
  data: [
    { id: 'deepseek-official/deepseek-flash', input: ['text', 'image'] },
    { id: 'deepseek-official/deepseek-v4-pro', input: ['text'] },
    { id: 'our-free-model-vision/glm-5.3-flash-free', input: ['text', 'image'] },
    { id: 'dfy-vision/deepseek-v4.1-flash-1017', input: ['text', 'image'] },
  ],
}

async function gateway(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, key: 'k', close: () => new Promise((resolve) => server.close(resolve)) }
}

test('pickVisionModel 只挑能看图的模型，并优先官方通道', async () => {
  const s = await gateway((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const model = await pickVisionModel(s)
    assert.equal(model, 'deepseek-official/deepseek-flash')
    // 指定 prefer 时优先用户的选择
    assert.equal(await pickVisionModel(s, 'dfy-vision/deepseek-v4.1-flash-1017'), 'dfy-vision/deepseek-v4.1-flash-1017')
  } finally {
    await s.close()
  }
})

test('没有视觉模型时抛 no-vision-model', async () => {
  const s = await gateway((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'only-text', input: ['text'] }] }))
  })
  try {
    await assert.rejects(() => pickVisionModel(s), (error) => {
      assert.ok(error instanceof VisionError)
      assert.equal(error.code, 'no-vision-model')
      return true
    })
  } finally {
    await s.close()
  }
})

test('describeImage 走 chat/completions 并回传文本', async () => {
  let seenBody = null
  const s = await gateway((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS))
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seenBody = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '一只蓝色的鲸鱼。' } }] }))
    })
  })
  try {
    const result = await describeImage({
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
      mimeType: 'image/png',
      prompt: '图里是什么',
      env: { DSH_OPENAI_GATEWAY_BASE: s.baseUrl, DSH_OPENAI_GATEWAY_API_KEY: 'k' },
    })
    assert.equal(result.ok, true)
    assert.equal(result.text, '一只蓝色的鲸鱼。')
    assert.equal(result.backend, 'gateway')
    assert.equal(seenBody.model, 'deepseek-official/deepseek-flash')
    assert.match(seenBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
  } finally {
    await s.close()
  }
})

test('describeImage 在网关报 502 时给出可行动的 code', async () => {
  const s = await gateway((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS))
      return
    }
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream failed' } }))
  })
  try {
    await assert.rejects(
      () =>
        describeImage({
          buffer: Buffer.from([1, 2, 3]),
          mimeType: 'image/png',
          env: { DSH_OPENAI_GATEWAY_BASE: s.baseUrl, DSH_OPENAI_GATEWAY_API_KEY: 'k' },
        }),
      (error) => {
        assert.equal(error.code, 'vision-backend-unavailable')
        assert.match(error.message, /upstream failed/)
        return true
      },
    )
  } finally {
    await s.close()
  }
})