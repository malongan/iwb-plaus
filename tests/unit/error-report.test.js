import {describe, it, expect, vi} from 'vitest'
import {
  installErrorBoundary,
  recordError,
  readLastError,
  clearLastError,
  describeError,
  LAST_ERROR_KEY
} from '../../iwb-cutout-extension/src/shared/error-report.js'

/** 伪造 chrome.storage.local */
function fakeStorage(initial = {}) {
  const store = {...initial}
  return {
    store,
    chrome: {
      storage: {
        local: {
          set: async obj => Object.assign(store, obj),
          get: async key => ({[key]: store[key]}),
          remove: async key => {
            delete store[key]
          }
        }
      }
    }
  }
}

describe('recordError / readLastError', () => {
  it('落盘并可读回', async () => {
    const {chrome, store} = fakeStorage()
    const entry = await recordError(new Error('画布炸了'), 'editor', chrome)
    expect(entry.message).toBe('画布炸了')
    expect(entry.source).toBe('editor')
    expect(entry.stack).toContain('Error')
    expect(store[LAST_ERROR_KEY].message).toBe('画布炸了')

    expect((await readLastError(chrome)).message).toBe('画布炸了')
    await clearLastError(chrome)
    expect(await readLastError(chrome)).toBeNull()
  })

  it('chrome 缺失或抛错时也不影响主流程', async () => {
    await expect(recordError(new Error('x'), 's', undefined)).resolves.toMatchObject({message: 'x'})
    const broken = {
      storage: {
        local: {
          set: async () => {
            throw new Error('quota')
          }
        }
      }
    }
    await expect(recordError(new Error('x'), 's', broken)).resolves.toMatchObject({message: 'x'})
    expect(await readLastError(broken)).toBeNull()
    await clearLastError(broken)
  })

  it('非 Error 对象也能记录', async () => {
    const {chrome} = fakeStorage()
    const entry = await recordError('裸字符串', 'misc', chrome)
    expect(entry.message).toBe('裸字符串')
    expect((await readLastError(chrome)).source).toBe('misc')
  })
})

describe('installErrorBoundary', () => {
  it('捕获 error 事件并回调 onFatal', async () => {
    const {chrome} = fakeStorage()
    const onFatal = vi.fn()
    const fakeWin = {addEventListener: vi.fn(), removeEventListener: vi.fn()}
    const boundary = installErrorBoundary({onFatal, windowRef: fakeWin, chromeRef: chrome})

    expect(fakeWin.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))
    expect(fakeWin.addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))

    const listener = fakeWin.addEventListener.mock.calls.find(c => c[0] === 'error')[1]
    listener({error: new Error('未捕获异常')})

    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1))
    expect(onFatal.mock.calls[0][0]).toMatchObject({message: '未捕获异常', source: 'window.onerror'})

    boundary.dispose()
    expect(fakeWin.removeEventListener).toHaveBeenCalledTimes(2)
  })

  it('同类错误在 10 秒内只提示一次（不刷屏），但每次都落盘', async () => {
    const {chrome, store} = fakeStorage()
    const onFatal = vi.fn()
    const fakeWin = {addEventListener: vi.fn(), removeEventListener: vi.fn()}
    installErrorBoundary({onFatal, windowRef: fakeWin, chromeRef: chrome})
    const listener = fakeWin.addEventListener.mock.calls.find(c => c[0] === 'error')[1]

    listener({error: new Error('同一个')})
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1))
    listener({error: new Error('同一个')})
    await vi.waitFor(() => expect(store[LAST_ERROR_KEY]).toBeTruthy())
    // 第二次不再提示
    await new Promise(r => setTimeout(r, 30))
    expect(onFatal).toHaveBeenCalledTimes(1)

    // 不同 source 不受限
    listener({error: new Error('另一个')})
    await new Promise(r => setTimeout(r, 30))
    expect(store[LAST_ERROR_KEY].source).toBe('window.onerror')
  })

  it('捕获 unhandledrejection', async () => {
    const {chrome} = fakeStorage()
    const onFatal = vi.fn()
    const fakeWin = {addEventListener: vi.fn(), removeEventListener: vi.fn()}
    installErrorBoundary({onFatal, windowRef: fakeWin, chromeRef: chrome})
    const listener = fakeWin.addEventListener.mock.calls.find(c => c[0] === 'unhandledrejection')[1]

    listener({reason: new Error('Promise 没人接')})
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1))
    expect(onFatal.mock.calls[0][0]).toMatchObject({source: 'unhandledrejection'})
  })

  it('资源加载类 error 事件被忽略（img 404 不算扩展异常）', async () => {
    const {chrome} = fakeStorage()
    const onFatal = vi.fn()
    const fakeWin = {addEventListener: vi.fn(), removeEventListener: vi.fn()}
    installErrorBoundary({onFatal, windowRef: fakeWin, chromeRef: chrome})
    const listener = fakeWin.addEventListener.mock.calls.find(c => c[0] === 'error')[1]

    listener({target: {tagName: 'IMG'}, message: 'Resource failed to load'})
    await new Promise(r => setTimeout(r, 30))
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('onFatal 自己抛异常也不会把边界打穿', async () => {
    const {chrome} = fakeStorage()
    const fakeWin = {addEventListener: vi.fn(), removeEventListener: vi.fn()}
    installErrorBoundary({
      onFatal: () => {
        throw new Error('提示自己炸了')
      },
      windowRef: fakeWin,
      chromeRef: chrome
    })
    const listener = fakeWin.addEventListener.mock.calls.find(c => c[0] === 'error')[1]
    expect(() => listener({error: new Error('x')})).not.toThrow()
    await new Promise(r => setTimeout(r, 30))
  })
})

describe('describeError', () => {
  it('生成可读的一句话并截断超长消息', () => {
    expect(describeError(null)).toContain('未知错误')
    const s = describeError({message: 'x'.repeat(500), source: 'editor'})
    expect(s).toContain('editor')
    expect(s.length).toBeLessThan(220)
  })
})
