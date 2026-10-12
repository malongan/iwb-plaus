import {describe, it, expect} from 'vitest'
import {
  resolveImageDataRef,
  blobToDataUrl,
  HOST_IDB_NAME,
  HOST_IDB_VERSION,
  HOST_IDB_IMAGES_STORE,
  HOST_IMAGE_CACHE
} from '../../iwb-cutout-extension/src/shared/original-image.js'

/** 造一个最小可用的 IDB 替身：open() → { result: { transaction().objectStore().get() } } */
function fakeIndexedDB(value) {
  const calls = []
  return {
    calls,
    open(name, version) {
      calls.push({name, version})
      const req = {}
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: {contains: (s) => s === HOST_IDB_IMAGES_STORE},
          transaction: (store, mode) => {
            calls.push({store, mode})
            return {
              objectStore: () => ({
                get: (key) => {
                  calls.push({get: key})
                  const r = {}
                  queueMicrotask(() => {
                    r.result = typeof value === 'function' ? value(key) : value
                    if (r.onsuccess) r.onsuccess()
                  })
                  return r
                }
              })
            }
          },
          close: () => calls.push({closed: true})
        }
        if (req.onsuccess) req.onsuccess()
      })
      return req
    }
  }
}

function fakeCaches(blob, calls = []) {
  return {
    calls,
    open: async (name) => {
      calls.push({cacheOpen: name})
      return {
        match: async (req) => {
          calls.push({match: String(req && req.url)})
          return blob ? {blob: async () => blob} : undefined
        }
      }
    }
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

describe('字符串形态引用', () => {
  it('dataURL / blob URL / 远端 URL 各自归类', async () => {
    expect(await resolveImageDataRef('data:image/png;base64,AAAA')).toEqual({base64: 'data:image/png;base64,AAAA'})
    expect(await resolveImageDataRef('blob:http://x/uuid')).toEqual({blobUrl: 'blob:http://x/uuid'})
    expect(await resolveImageDataRef('https://x/a.png')).toEqual({url: 'https://x/a.png'})
  })

  it('空值 / 无法识别的形态 → null（不抛错）', async () => {
    expect(await resolveImageDataRef(null)).toBeNull()
    expect(await resolveImageDataRef('')).toBeNull()
    expect(await resolveImageDataRef('file:///tmp/a.png')).toBeNull()
    expect(await resolveImageDataRef(123)).toBeNull()
  })
})

describe('{__blob} → IndexedDB', () => {
  it('按 key 读出 Blob 并转 dataURL，且用宿主的库/表契约打开', async () => {
    const blob = new Blob([PNG_BYTES], {type: 'image/png'})
    const idb = fakeIndexedDB(blob)
    const out = await resolveImageDataRef({__blob: 'imgblob_abc_8'}, {indexedDB: idb, FileReader: undefined})
    expect(out.base64).toMatch(/^data:image\/png;base64,/)
    expect(idb.calls[0]).toEqual({name: HOST_IDB_NAME, version: HOST_IDB_VERSION})
    expect(idb.calls).toContainEqual({store: HOST_IDB_IMAGES_STORE, mode: 'readonly'})
    expect(idb.calls).toContainEqual({get: 'imgblob_abc_8'})
  })

  it('key 不存在 / 读失败 → null', async () => {
    expect(await resolveImageDataRef({__blob: 'imgblob_missing_0'}, {indexedDB: fakeIndexedDB(undefined)})).toBeNull()
    const broken = {open: () => { throw new Error('denied') }}
    expect(await resolveImageDataRef({__blob: 'x'}, {indexedDB: broken})).toBeNull()
    expect(await resolveImageDataRef({__blob: 'x'}, {indexedDB: null})).toBeNull()
  })
})

describe('{__cache} → Cache Storage', () => {
  it('按同源虚拟路径读字节并转 dataURL', async () => {
    const blob = new Blob([PNG_BYTES], {type: 'image/webp'})
    const calls = []
    const out = await resolveImageDataRef(
      {__cache: '/__iwb_cache__/deadbeef'},
      {caches: fakeCaches(blob, calls), origin: 'https://iwb.example'}
    )
    expect(out.base64).toMatch(/^data:image\/webp;base64,/)
    expect(calls[0]).toEqual({cacheOpen: HOST_IMAGE_CACHE})
    expect(calls[1].match).toContain('https://iwb.example/__iwb_cache__/deadbeef')
  })

  it('缓存未命中 / caches 不可用 → null', async () => {
    expect(await resolveImageDataRef({__cache: '/__iwb_cache__/nope'}, {caches: fakeCaches(undefined), origin: 'https://x'})).toBeNull()
    expect(await resolveImageDataRef({__cache: '/__iwb_cache__/nope'}, {caches: null})).toBeNull()
  })
})

describe('blobToDataUrl', () => {
  it('无 FileReader 时退回 arrayBuffer 路径', async () => {
    const blob = new Blob([PNG_BYTES], {type: 'image/png'})
    const out = await blobToDataUrl(blob, undefined)
    expect(out).toMatch(/^data:image\/png;base64,/)
  })

  it('null blob → null', async () => {
    expect(await blobToDataUrl(null)).toBeNull()
  })
})
