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
    AbortController, setTimeout, clearTimeout,
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
    setTimeout,
    clearTimeout,
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

const MiB = 1024 * 1024

/**
 * Drives the client's large-file path against a scripted server.
 *   script(n)  -> what the n-th chunk request answers: { status, body }, or
 *                 { hang: true } to leave it unanswered (a dead connection)
 * Timers: retry waits (<= 25 s, except the 8 s panel removal) fire at once;
 * every longer one (stall watchdogs, API timeouts) waits for fire(ms).
 */
function chunkHarness(script, { store = new Map(), fileSize = 8 * MiB + 1, clock = { now: 1000 }, status } = {}) {
  const elements = new Map()
  let panel
  class Element {
    constructor() { this.listeners = {}; this.children = []; this.hidden = false }
    addEventListener(type, callback) { this.listeners[type] = callback }
    append(...children) {
      this.children.push(...children)
      for (const c of children) if (c.id) elements.set(c.id, c)
      for (const c of children) if (c.id === 'catsuki-upload-progress') panel = c
    }
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
  const slices = []
  const timers = []
  let statusCalls = 0
  let chunkCalls = 0
  class FakeXhr {
    constructor() { this.upload = {}; this.headers = {} }
    open(method, url) { this.url = url }
    setRequestHeader(key, value) { this.headers[key] = value }
    send() {
      chunkCalls++
      sentHeaders.push(this.headers)
      const step = script(chunkCalls)
      if (step.hang) return
      setImmediate(() => {
        this.status = step.status
        this.responseText = JSON.stringify(step.body)
        step.networkError ? this.onerror() : this.onload()
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
  const reply = (code, data, ok = true, httpStatus = ok ? 200 : code) =>
    ({ ok, status: httpStatus, json: async () => ({ code, data, message: ok ? 'success' : 'error' }) })
  const code = fs.readFileSync(new URL('./frontend-upload-client.js', import.meta.url), 'utf8')
  vm.runInNewContext(code, {
    document,
    addEventListener: (event, callback) => { globalEvents[event] = callback },
    MutationObserver: class { observe() {} },
    XMLHttpRequest: FakeXhr,
    localStorage: {
      getItem: key => (key === 'token' ? 'test-token' : store.get(key) ?? null),
      setItem: (key, value) => { store.set(key, String(value)) },
    },
    location: { pathname: '/GoogleDrive2' },
    performance: { now: () => clock.now }, AbortController, DOMException, MouseEvent: class {},
    setTimeout: (fn, ms) => {
      if (ms <= 25000 && ms !== 8000) { setImmediate(fn); return 0 }
      const timer = { fn, ms, live: true }
      timers.push(timer)
      return timer
    },
    clearTimeout: timer => { if (timer) timer.live = false },
    fetch: async (url, options = {}) => {
      apiCalls.push(url)
      if (url.endsWith('/upload/cancel')) { cancelHeaders.push(options.headers); return reply(200, null) }
      if (url.endsWith('/folder_quota')) return reply(404, null, false)
      if (url.endsWith('/upload/status')) {
        statusCalls++
        const answer = status ? status(statusCalls, options) : { complete: false, next_offset: 0 }
        if (answer?.hang) {
          return new Promise((resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        }
        return reply(200, answer)
      }
      return reply(200, { token: 's', chunk_size: 8 * MiB })
    },
  })
  documentEvents.DOMContentLoaded()
  globalEvents.DOMContentLoaded()
  elements.set('catsuki-upload-button', new Element())
  const file = {
    name: 'big.bin', size: fileSize, type: '', lastModified: 1700000000000,
    slice: (a, b) => { slices.push([a, b]); return { size: b - a } },
  }
  input.files = [file]
  return {
    input, elements, apiCalls, cancelHeaders, sentHeaders, slices, store, clock,
    chunkCalls: () => chunkCalls,
    panel: () => panel,
    size: fileSize,
    // Run the live timer of a given length, as if that long had passed.
    fire(ms) {
      const timer = timers.filter(t => t.live && t.ms === ms).pop()
      assert.ok(timer, `a ${ms} ms timer should be pending`)
      timer.live = false
      timer.fn()
    },
  }
}
const ok = data => ({ status: 200, body: { code: 200, data } })
const fail = (status, message = 'busy') => ({ status, body: { code: status, message } })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('large upload rides out several transient chunk failures', async () => {
  const h = chunkHarness(n => n <= 5 ? fail(503)
    : ok({ complete: n === 7, next_offset: n === 6 ? 8 * MiB : h.size }))
  await h.input.listeners.change()
  assert.equal(h.panel().children[0].textContent, '上传完成')
  assert.equal(h.chunkCalls(), 7)
  assert.ok(!h.apiCalls.some(url => url.endsWith('/upload/cancel')), 'a finished upload is not cancelled')
  assert.equal(h.store.get('catsuki-upload-sessions') === undefined || h.store.get('catsuki-upload-sessions') === '{}', true,
    'a finished upload leaves nothing to resume')
})

test('large upload does not retry a permission error', async () => {
  const h = chunkHarness(() => fail(403, 'Invalid upload session'))
  await h.input.listeners.change()
  assert.equal(h.panel().children[0].textContent, '上传失败')
  assert.equal(h.chunkCalls(), 1)
  assert.equal(h.cancelHeaders.length, 1, 'a failed upload hands its session back')
  assert.equal(h.cancelHeaders[0]['X-Google-Upload-Token'], 's')
})

test('large upload sends the renewed token from each chunk answer', async () => {
  const h = chunkHarness(n => n === 1
    ? ok({ complete: false, next_offset: 8 * MiB, token: 'fresh-1' })
    : ok({ complete: true, next_offset: h.size }))
  await h.input.listeners.change()
  assert.equal(h.chunkCalls(), 2)
  assert.equal(h.sentHeaders[0]['X-Google-Upload-Token'], 's')
  assert.equal(h.sentHeaders[1]['X-Google-Upload-Token'], 'fresh-1')
})

test('a failed chunk is retried smaller, and the size recovers after clean chunks', async () => {
  const size = 40 * MiB
  const end = () => h.slices.at(-1)[1]
  const h = chunkHarness(n => n === 1 ? fail(502)
    : ok({ complete: end() === size, next_offset: end(), token: 's' }), { fileSize: size })
  const upload = h.input.listeners.change()
  // After the first failure the same offset is retried at half the size.
  for (let i = 0; h.slices.length < 2 && i < 50; i++) await tick()
  assert.deepEqual(h.slices[0], [0, 8 * MiB])
  assert.deepEqual(h.slices[1], [0, 4 * MiB])
  // Three clean chunks later the size is back to normal.
  for (let i = 0; h.slices.length < 6 && i < 200; i++) await tick()
  const lengths = h.slices.map(([a, b]) => (b - a) / MiB)
  assert.deepEqual(lengths.slice(1, 6), [4, 4, 4, 8, 8])
  await upload
  assert.equal(h.panel().children[0].textContent, '上传完成')
})

test('a request that stops moving is abandoned and retried', async () => {
  const h = chunkHarness(n => n === 1 ? { hang: true }
    : ok({ complete: n === 3, next_offset: n === 2 ? 8 * MiB : h.size }))
  const upload = h.input.listeners.change()
  for (let i = 0; h.chunkCalls() < 1 && i < 50; i++) await tick()
  h.fire(45000) // the watchdog: no upload progress for 45 s
  await upload
  assert.equal(h.panel().children[0].textContent, '上传完成')
  assert.equal(h.chunkCalls(), 3)
})

test('a hung status check times out instead of freezing the panel', async () => {
  const h = chunkHarness(n => n === 1 ? fail(503) : ok({ complete: true, next_offset: h.size }),
    { status: n => (n === 1 ? { hang: true } : { complete: false, next_offset: 0 }) })
  const upload = h.input.listeners.change()
  for (let i = 0; h.apiCalls.filter(url => url.endsWith('/upload/status')).length < 1 && i < 50; i++) await tick()
  h.fire(30000) // the API timeout
  await upload
  assert.equal(h.panel().children[0].textContent, '上传完成')
})

test('an outage pauses the upload and choosing the same file resumes it', async () => {
  const clock = { now: 1000 }
  const store = new Map()
  const size = 20 * MiB
  // First run: one chunk lands, then the network disappears for good.
  const first = chunkHarness(n => n === 1
    ? ok({ complete: false, next_offset: 8 * MiB, token: 'fresh-1' })
    : { networkError: true }, { store, fileSize: size, clock })
  const run = first.input.listeners.change()
  for (let i = 0; first.chunkCalls() < 3 && i < 100; i++) await tick()
  clock.now += 11 * 60 * 1000 // longer than the patience window
  await run
  const panel = first.panel()
  assert.equal(panel.children[0].textContent, '上传失败')
  assert.match(panel.children[2].textContent, /重新选择同一个文件.*40%/)
  assert.equal(first.cancelHeaders.length, 0, 'the session is kept for resuming')
  assert.ok(store.get('catsuki-upload-sessions').includes('fresh-1'), 'the renewed token is remembered')

  // Second run: the same file continues from what Google already holds.
  const second = chunkHarness(() => ok({ complete: true, next_offset: size }),
    { store, fileSize: size, clock, status: () => ({ complete: false, next_offset: 8 * MiB, token: 'resumed' }) })
  await second.input.listeners.change()
  assert.equal(second.panel().children[0].textContent, '上传完成')
  assert.ok(!second.apiCalls.some(url => url.endsWith('/upload/start')), 'no new session is opened')
  assert.equal(second.sentHeaders[0]['X-Upload-Offset'], String(8 * MiB))
  assert.equal(second.sentHeaders[0]['X-Google-Upload-Token'], 'resumed')
  assert.equal(JSON.parse(store.get('catsuki-upload-sessions') || '{}')['/GoogleDrive2/big.bin|' + size + '|1700000000000'], undefined)
})
