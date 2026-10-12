import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

for (const scoped of [false, true]) test(`root quota observer converges for ${scoped ? 'scoped' : 'admin'} user`, async () => {
  const elements = new Map()
  let mutations = 0
  let observe
  class Element {
    addEventListener() {}
    append() {}
    setAttribute() {}
    after(child) { elements.set(child.id, child); mutations++ }
    remove() { if (elements.delete(this.id)) mutations++ }
    set textContent(value) { this.text = value; mutations++ }
    get textContent() { return this.text }
  }
  const events = {}
  const code = fs.readFileSync(new URL('./frontend-upload-client.js', import.meta.url), 'utf8')
  vm.runInNewContext(code, {
    document: {
      createElement: () => new Element(), body: new Element(), addEventListener() {},
      getElementById: id => elements.get(id), querySelector: () => new Element(),
    },
    addEventListener: (name, callback) => { events[name] = callback },
    MutationObserver: class { constructor(callback) { observe = callback } observe() {} },
    localStorage: { getItem: () => 'test-token' }, location: { pathname: '/' },
    fetch: async () => ({ ok: scoped, status: scoped ? 200 : 404,
      json: async () => scoped ? { code: 200, data: { used: 0, limit: 536870912000 } } : { code: 404 } }),
  })
  events.DOMContentLoaded()
  await new Promise(resolve => setImmediate(resolve))
  let rounds = 0
  while (mutations && rounds < 20) { mutations = 0; observe(); rounds++ }
  assert.equal(mutations, 0, 'DOM observer must settle rather than repeatedly create/remove cards')
  assert.ok(rounds < 20)
  const card = elements.get('catsuki-drive-quota')
  if (scoped) assert.match(card.textContent, /500\.0 GB/)
  else assert.equal(card, undefined)
})

test('upload panel shows progress and cancel aborts the current chunk and remaining queue', async () => {
  const elements = new Map()
  class Element {
    constructor(tag) { this.tag = tag; this.listeners = {}; this.children = []; this.hidden = false }
    addEventListener(type, callback) { this.listeners[type] = callback }
    append(...children) {
      this.children.push(...children)
      for (const child of children) if (child.id) elements.set(child.id, child)
    }
    after(child) { if (child.id) elements.set(child.id, child) }
    remove() { elements.delete(this.id) }
    setAttribute() {}
    focus() {}
    click() { this.listeners.click?.() }
  }
  const documentEvents = {}
  const globalEvents = {}
  const input = new Element('input')
  const breadcrumb = new Element('nav')
  let activeXhr
  let requests = 0
  const apiCalls = []
  class FakeXhr {
    constructor() { this.upload = {}; activeXhr = this }
    open() {}
    setRequestHeader() {}
    send() { requests++ }
    abort() { this.onabort?.() }
  }
  const document = {
    body: new Element('body'),
    createElement: tag => tag === 'input' ? input : new Element(tag),
    addEventListener: (event, callback) => { documentEvents[event] = callback },
    getElementById: id => elements.get(id) || null,
    querySelector: selector => {
      if (selector === '.catsuki-upload-icon') return new Element('svg')
      if (selector === '[aria-label="breadcrumb"]') return breadcrumb
      return null
    },
  }
  const code = fs.readFileSync(new URL('./frontend-upload-client.js', import.meta.url), 'utf8')
  vm.runInNewContext(code, {
    document,
    addEventListener: (event, callback) => { globalEvents[event] = callback },
    MutationObserver: class { observe() {} },
    XMLHttpRequest: FakeXhr,
    localStorage: { getItem: () => 'test-token' },
    location: { pathname: '/GoogleDrive2' },
    performance,
    AbortController,
    DOMException,
    MouseEvent: class {},
    fetch: async (url, options) => {
      apiCalls.push({ url, options })
      if (url.endsWith('/folder_quota')) return {
        ok: false, status: 404,
        json: async () => ({ code: 404, message: 'No folder quota' }),
      }
      return {
        ok: true, status: 200,
        json: async () => ({ code: 200, data: { token: 'session', chunk_size: 8 * 1024 * 1024 } }),
      }
    },
  })
  documentEvents.DOMContentLoaded()
  globalEvents.DOMContentLoaded()
  const file = { name: 'large.bin', size: 32 * 1024 * 1024, type: 'application/octet-stream', slice: () => ({ size: 8 * 1024 * 1024 }) }
  input.files = [file, { ...file, name: 'queued.bin' }]
  const upload = input.listeners.change()
  for (let i = 0; !activeXhr && i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(activeXhr, 'a chunk request should start')
  activeXhr.upload.onprogress({ loaded: 4 * 1024 * 1024 })
  const panel = elements.get('catsuki-upload-progress')
  assert.match(panel.children[3].textContent, /4\.00 MB \/ 32\.0 MB/)
  assert.match(panel.children[4].textContent, /64\.0 MB/)
  const cancel = panel.children[7].children[0]
  assert.equal(cancel.textContent, '取消上传')
  cancel.click()
  await upload
  assert.equal(panel.children[0].textContent, '上传已取消')
  assert.equal(requests, 1, 'the queued file must not start')
  assert.equal(panel.children[7].children[1].hidden, false, 'close becomes available')

  elements.get('catsuki-folder-button').click()
  const dialog = elements.get('catsuki-folder-dialog')
  assert.ok(dialog)
  dialog.children[1].value = 'wxb_nb'
  await dialog.listeners.submit({ preventDefault() {} })
  assert.ok(apiCalls.some(call => call.url.endsWith('/mkdir') &&
    JSON.parse(call.options.body).path === '/GoogleDrive2/wxb_nb'))
})

function chunkHarness(script) {
  const elements = new Map()
  class Element {
    constructor() { this.listeners = {}; this.children = []; this.hidden = false }
    addEventListener(type, callback) { this.listeners[type] = callback }
    append(...children) { this.children.push(...children); for (const c of children) if (c.id) elements.set(c.id, c) }
    after(child) { if (child.id) elements.set(child.id, child) }
    remove() { elements.delete(this.id) }
    setAttribute() {}
    click() { this.listeners.click?.() }
  }
  const input = new Element()
  const documentEvents = {}
  const globalEvents = {}
  const apiCalls = []
  const cancelHeaders = []
  const sentHeaders = []
  let chunkCalls = 0
  class FakeXhr {
    constructor() { this.upload = {}; this.headers = {} }
    open(method, url) { this.url = url }
    setRequestHeader(key, value) { this.headers[key] = value }
    send(body) {
      chunkCalls++
      sentHeaders.push(this.headers)
      const step = script(chunkCalls)
      setImmediate(() => {
        this.status = step.status
        this.responseText = JSON.stringify(step.body)
        this.onload()
      })
    }
    abort() { this.onabort?.() }
  }
  const document = {
    body: new Element(),
    createElement: tag => tag === 'input' ? input : new Element(),
    addEventListener: (event, callback) => { documentEvents[event] = callback },
    getElementById: id => elements.get(id) || null,
    querySelector: selector => (selector === '.catsuki-upload-icon' ? new Element() : null),
  }
  const code = fs.readFileSync(new URL('./frontend-upload-client.js', import.meta.url), 'utf8')
  vm.runInNewContext(code, {
    document,
    addEventListener: (event, callback) => { globalEvents[event] = callback },
    MutationObserver: class { observe() {} },
    XMLHttpRequest: FakeXhr,
    localStorage: { getItem: () => 'test-token' },
    location: { pathname: '/GoogleDrive2' },
    performance, AbortController, DOMException, MouseEvent: class {},
    setTimeout: (fn, ms) => (ms >= 8000 ? 0 : setImmediate(fn)),
    clearTimeout: () => {},
    fetch: async (url, options = {}) => {
      apiCalls.push(url)
      if (url.endsWith('/upload/cancel')) cancelHeaders.push(options.headers)
      if (url.endsWith('/folder_quota')) return { ok: false, status: 404, json: async () => ({ code: 404 }) }
      if (url.endsWith('/upload/status')) return { ok: true, status: 200, json: async () => ({ code: 200, data: { complete: false, next_offset: 0 } }) }
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { token: 's', chunk_size: 8 * 1024 * 1024 } }) }
    },
  })
  documentEvents.DOMContentLoaded()
  globalEvents.DOMContentLoaded()
  elements.set('catsuki-upload-button', new Element())
  const size = 8 * 1024 * 1024 + 1
  input.files = [{ name: 'big.bin', size, type: '', slice: (a, b) => ({ size: b - a }) }]
  return { input, elements, chunkCalls: () => chunkCalls, apiCalls, cancelHeaders, sentHeaders, size }
}

test('large upload rides out several transient chunk failures', async () => {
  const h = chunkHarness(n => n <= 5
    ? { status: 503, body: { code: 503, message: 'busy' } }
    : { status: 200, body: { code: 200, data: { complete: n === 7, next_offset: n === 6 ? 8 * 1024 * 1024 : h.size } } })
  await h.input.listeners.change()
  assert.equal(h.elements.get('catsuki-upload-progress').children[0].textContent, '上传完成')
  assert.equal(h.chunkCalls(), 7)
  assert.ok(!h.apiCalls.some(url => url.endsWith('/upload/cancel')), 'a finished upload is not cancelled')
})

test('large upload does not retry a permission error', async () => {
  const h = chunkHarness(() => ({ status: 403, body: { code: 403, message: 'Invalid upload session' } }))
  await h.input.listeners.change()
  const panel = h.elements.get('catsuki-upload-progress')
  assert.equal(panel.children[0].textContent, '上传失败')
  assert.equal(h.chunkCalls(), 1)
  assert.equal(h.cancelHeaders.length, 1, 'a failed upload hands its session back')
  assert.equal(h.cancelHeaders[0]['X-Google-Upload-Token'], 's')
})

test('large upload sends the renewed token from each chunk answer', async () => {
  const h = chunkHarness(n => n === 1
    ? { status: 200, body: { code: 200, data: { complete: false, next_offset: 8 * 1024 * 1024, token: 'fresh-1' } } }
    : { status: 200, body: { code: 200, data: { complete: true, next_offset: h.size } } })
  await h.input.listeners.change()
  assert.equal(h.chunkCalls(), 2)
  assert.equal(h.sentHeaders[0]['X-Google-Upload-Token'], 's')
  assert.equal(h.sentHeaders[1]['X-Google-Upload-Token'], 'fresh-1')
})
