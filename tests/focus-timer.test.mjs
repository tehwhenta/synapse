import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173' })
const runtimePath = fileURLToPath(new URL('./.focus-timer-runtime.mjs', import.meta.url))
let FocusTimer, mount, flushPromises
before(async () => {
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
  const compiled = await build({ stdin: { contents: "export { default } from './src/components/FocusTimer.vue';", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'focus-test', setup(builder) {
    builder.onResolve({ filter: /stores\/workspace$/ }, () => ({ path: 'workspace-mock', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const useWorkspaceStore = () => globalThis.__focusWorkspace;', loader: 'js' }))
    builder.onLoad({ filter: /\.vue$/ }, args => { const { descriptor } = parse(readFileSync(args.path, 'utf8')); return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'js', resolveDir: dirname(args.path) } })
  } }] })
  writeFileSync(runtimePath, compiled.outputFiles[0].contents)
  FocusTimer = (await import(pathToFileURL(runtimePath).href)).default
  const utils = await import('@vue/test-utils'); mount = utils.mount; flushPromises = utils.flushPromises
})
after(() => { delete globalThis.__focusWorkspace; dom.window.close(); try { unlinkSync(runtimePath) } catch {} })
function setup() {
  const saved = []
  globalThis.__focusWorkspace = { selectedFolderId: 'study-space', async logSession(seconds, folder) { saved.push({ seconds, folder }) } }
  return { wrapper: mount(FocusTimer, { attachTo: document.body }), saved }
}
async function wheel(wrapper, deltaY, extra = {}) {
  const event = new dom.window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...extra })
  wrapper.find('.timer-display').element.dispatchEvent(event)
  await flushPromises()
  return event
}

test('Hover-wheel controls update the timer and its duration label without blocking browser zoom', async () => {
  const { wrapper, saved } = setup()
  try {
    assert.equal(wrapper.find('.timer-display').text(), '25:00')
    assert.equal(wrapper.find('.time-wheel-previous').text(),'24:00')
    assert.equal(wrapper.find('.time-wheel-next').text(),'26:00')
    assert.equal((await wheel(wrapper, -100)).defaultPrevented, true)
    assert.equal(wrapper.find('.timer-display').text(), '26:00')
    assert.equal(wrapper.find('.time-wheel-previous').text(),'25:00')
    assert.equal(wrapper.find('.time-wheel-next').text(),'27:00')
    assert.ok(wrapper.find('.timer-wheel').classes().includes('wheel-active'))
    assert.match(wrapper.find('.rail-title').text(), /26 MIN/)
    await wheel(wrapper, 100)
    assert.equal(wrapper.find('.timer-display').text(), '25:00')
    assert.equal((await wheel(wrapper, -100, { ctrlKey: true })).defaultPrevented, false)
    assert.equal(wrapper.find('.timer-display').text(), '25:00')
    assert.deepEqual(saved, [])
  } finally { wrapper.unmount() }
})

test('Keyboard controls and wheel bounds keep duration between one minute and three hours', async () => {
  const { wrapper } = setup()
  try {
    const timer = wrapper.find('[role="spinbutton"]')
    await timer.trigger('keydown', { key: 'Home' })
    await wheel(wrapper, 100)
    assert.equal(timer.text(), '01:00')
    assert.equal(wrapper.find('.time-wheel-previous').text(),'')
    await timer.trigger('keydown', { key: 'End' })
    await wheel(wrapper, -100)
    assert.equal(timer.text(), '180:00')
    assert.equal(wrapper.find('.time-wheel-next').text(),'')
    await timer.trigger('keydown', { key: 'ArrowDown' })
    assert.equal(timer.text(), '179:00')
    assert.equal(timer.attributes('aria-valuenow'), String(179 * 60))
    await wrapper.find('[aria-label="Finish or reset focus session"]').trigger('click')
    assert.equal(timer.text(), '179:00')
  } finally { wrapper.unmount() }
})

test('Running sessions ignore wheel changes and customization cannot inflate logged study time', async () => {
  const originalNow = Date.now
  let now = 1000000
  Date.now = () => now
  const { wrapper, saved } = setup()
  try {
    await wheel(wrapper, -100)
    await wrapper.find('.timer-actions .primary').trigger('click')
    assert.equal(wrapper.find('.timer-display').attributes('aria-readonly'), 'true')
    assert.equal((await wheel(wrapper, -100)).defaultPrevented, false)
    assert.match(wrapper.find('.rail-title').text(), /26 MIN/)
    now += 61000
    await wrapper.find('.timer-actions .primary').trigger('click')
    await wheel(wrapper, -100)
    await wrapper.find('[aria-label="Finish or reset focus session"]').trigger('click')
    await flushPromises()
    assert.deepEqual(saved, [{ seconds: 61, folder: 'study-space' }])
    assert.equal(wrapper.find('.timer-display').text(), '26:00')
  } finally { wrapper.unmount(); Date.now = originalNow }
})
