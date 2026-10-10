import { describe, it, expect } from 'vitest'
import { base64ToBytes, bytesToBase64, bytesToDataUrl, splitDataUrl, toFile, bufferToDataUrl } from '../../iwb-cutout-extension/src/shared/bytes.js'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('splitDataUrl', () => {
  it('拆出 mime 与纯 base64', () => {
    const r = splitDataUrl(PNG_DATA_URL)
    expect(r.mime).toBe('image/png')
    expect(r.base64).not.toContain('data:')
    expect(r.base64).not.toContain(',')
  })

  it('纯 base64 原样返回、mime 为 null', () => {
    const r = splitDataUrl('AAAA')
    expect(r.mime).toBeNull()
    expect(r.base64).toBe('AAAA')
  })

  it('非法输入不抛异常', () => {
    expect(splitDataUrl(undefined).base64).toBe('')
    expect(splitDataUrl(null).base64).toBe('')
  })
})

describe('base64 <-> bytes', () => {
  it('往返一致（dataURL 形式）', () => {
    const bytes = base64ToBytes(PNG_DATA_URL)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytesToBase64(bytes)).toBe(splitDataUrl(PNG_DATA_URL).base64)
  })

  it('往返一致（纯 base64 形式）', () => {
    const raw = 'aGVsbG8td29ybGQ='
    expect(bytesToBase64(base64ToBytes(raw))).toBe(raw)
  })

  it('大块数据走 32KB 分片，不会撑爆 apply 参数栈', () => {
    const big = new Uint8Array(200_000)
    for (let i = 0; i < big.length; i++) big[i] = i % 256
    const b64 = bytesToBase64(big)
    const back = base64ToBytes(b64)
    expect(back.length).toBe(big.length)
    expect(back[199_999]).toBe(big[199_999])
    expect(back[12345]).toBe(big[12345])
  })
})

describe('bufferToDataUrl / bytesToDataUrl', () => {
  it('输出带 PNG 头的 dataURL', () => {
    const bytes = base64ToBytes(PNG_DATA_URL)
    const url = bytesToDataUrl(bytes, 'image/png')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect(url).toBe(PNG_DATA_URL)
    expect(bufferToDataUrl(bytes.buffer.slice(0))).toBe(PNG_DATA_URL)
  })
})

describe('toFile', () => {
  it('从 dataURL 还原文件名与类型', () => {
    const f = toFile(PNG_DATA_URL, 'cutout.png')
    expect(f.name).toBe('cutout.png')
    expect(f.type).toBe('image/png')
    expect(f.size).toBeGreaterThan(0)
  })

  it('纯 base64 输入用兜底类型与文件名', () => {
    const f = toFile('AAAA', 'out.png', 'image/webp')
    expect(f.type).toBe('image/webp')
    expect(f.name).toBe('out.png')
  })
})
