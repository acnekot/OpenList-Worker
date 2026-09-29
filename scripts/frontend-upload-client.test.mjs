import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

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
