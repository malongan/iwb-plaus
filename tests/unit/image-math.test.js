import {describe, it, expect} from 'vitest'
import {hexToRgb, rgbToHex, parseRatio, fitRect, clamp} from '../../iwb-cutout-extension/src/shared/image-math.js'

describe('hexToRgb / rgbToHex', () => {
  it('6 位与 3 位十六进制', () => {
    expect(hexToRgb('#ff4444')).toEqual({r: 255, g: 68, b: 68})
    expect(hexToRgb('#f44')).toEqual({r: 255, g: 68, b: 68})
    expect(hexToRgb('1a7f37')).toEqual({r: 26, g: 127, b: 55})
  })

  it('非法输入给 0 而不是 NaN（旧实现会抛异常）', () => {
    expect(hexToRgb(undefined)).toEqual({r: 0, g: 0, b: 0})
    expect(hexToRgb('')).toEqual({r: 0, g: 0, b: 0})
    expect(hexToRgb('#zz')).toEqual({r: 0, g: 0, b: 0})
  })

  it('往返一致', () => {
    expect(rgbToHex(255, 68, 68)).toBe('#ff4444')
    expect(hexToRgb(rgbToHex(26, 127, 55))).toEqual({r: 26, g: 127, b: 55})
  })

  it('越界值被夹到 0~255，不会产出畸形 hex', () => {
    expect(rgbToHex(300, -5, 0)).toBe('#ff0000')
    expect(rgbToHex(1.4, 1.5, 1.6)).toBe('#010202')
  })
})

describe('parseRatio（裁剪比例约束）', () => {
  it('解析常用比例', () => {
    expect(parseRatio('1:1')).toBe(1)
    expect(parseRatio('16:9')).toBeCloseTo(16 / 9)
    expect(parseRatio('4:3')).toBeCloseTo(4 / 3)
  })

  it('free / 空 / 非法 → 0 表示不限制', () => {
    expect(parseRatio('free')).toBe(0)
    expect(parseRatio('')).toBe(0)
    expect(parseRatio(null)).toBe(0)
    expect(parseRatio('abc')).toBe(0)
    expect(parseRatio('16')).toBe(0)
    expect(parseRatio('0:5')).toBe(0)
    expect(parseRatio('-1:5')).toBe(0)
  })
})

describe('fitRect（白底大图布局）', () => {
  it('800 画布、85% 占比：最长边 = 680 且水平垂直居中', () => {
    const r = fitRect(400, 200, 800, 800, 0.85)
    expect(r.w).toBeCloseTo(680)
    expect(r.h).toBeCloseTo(340)
    expect(r.x).toBeCloseTo((800 - 680) / 2)
    expect(r.y).toBeCloseTo((800 - 340) / 2)
  })

  it('方图按占比正方形居中', () => {
    const r = fitRect(1000, 1000, 800, 800, 0.85)
    expect(r.w).toBeCloseTo(680)
    expect(r.h).toBeCloseTo(680)
    expect(r.x).toBeCloseTo(60)
    expect(r.y).toBeCloseTo(60)
  })

  it('竖图与横图都以"最长边受限"为准', () => {
    const tall = fitRect(100, 400, 800, 800, 1)
    expect(tall.h).toBeCloseTo(800)
    expect(tall.w).toBeCloseTo(200)

    const wide = fitRect(400, 100, 800, 800, 1)
    expect(wide.w).toBeCloseTo(800)
    expect(wide.h).toBeCloseTo(200)
  })

  it('透明底模式 ratio=1 时内容正好贴边', () => {
    const r = fitRect(512, 512, 800, 800, 1)
    expect(r.w).toBeCloseTo(800)
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(0)
  })

  it('非法尺寸返回全 0，避免 NaN 画进 canvas', () => {
    expect(fitRect(0, 100, 800, 800, 0.85)).toEqual({x: 0, y: 0, w: 0, h: 0, scale: 0})
    expect(fitRect(100, 100, 0, 800, 0.85).scale).toBe(0)
    expect(Number.isNaN(fitRect(100, 100, 800, 800, 0.85).x)).toBe(false)
  })

  it('越界占比被夹到 0.01~1', () => {
    expect(fitRect(100, 100, 800, 800, 5).w).toBeCloseTo(800)
    expect(fitRect(100, 100, 800, 800, 0).w).toBeCloseTo(8)
  })
})

describe('clamp', () => {
  it('夹紧到区间内', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })
})
