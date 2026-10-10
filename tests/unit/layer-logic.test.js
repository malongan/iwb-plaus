import { describe, it, expect } from 'vitest'
import { isDrawableLayer, restorePath, needsPixelSnapshot } from '../../iwb-cutout-extension/src/shared/layer-logic.js'

/**
 * 这组测试守护阶段二（快照分级）的核心不变量：
 * 快照端跳过像素的图层，恢复端一定不会读 bm.data。
 * 一旦有人改动其中一端的判定，这里立刻红。
 */

const base = { id: 'base', image: {}, sourceCanvas: null, transformable: true }
const draw = { id: 'draw', image: null, sourceCanvas: {}, transformable: true }
const imported = { id: 'layer-1', image: {}, sourceCanvas: null, transformable: true }
const plainBitmap = { id: 'layer-2', image: null, sourceCanvas: null, transformable: false }
const nonTransformable = { id: 'layer-3', image: {}, sourceCanvas: null, transformable: false }

describe('isDrawableLayer', () => {
  it('原图层与带 image 的图层不是绘制层', () => {
    expect(isDrawableLayer(base)).toBe(false)
    expect(isDrawableLayer(imported)).toBe(false)
  })

  it('画笔层、空白层（无 image）是绘制层', () => {
    expect(isDrawableLayer(draw)).toBe(true)
    expect(isDrawableLayer(plainBitmap)).toBe(true)
  })

  it('空入参安全返回 false', () => {
    expect(isDrawableLayer(null)).toBe(false)
    expect(isDrawableLayer(undefined)).toBe(false)
  })
})

describe('restorePath：决定快照要不要拍像素', () => {
  it('可重绘的图层（原图层/导入图层）走 redraw —— 其像素在恢复时不会被读', () => {
    expect(restorePath(base)).toBe('redraw')
    expect(restorePath(imported)).toBe('redraw')
    expect(needsPixelSnapshot(base)).toBe(false)
    expect(needsPixelSnapshot(imported)).toBe(false)
  })

  it('绘制层即使有 sourceCanvas 也走 pixels（恢复流程会先清掉 sourceCanvas）', () => {
    expect(restorePath(draw)).toBe('pixels')
    expect(needsPixelSnapshot(draw)).toBe(true)
  })

  it('不可变换的位图层走 pixels', () => {
    expect(restorePath(plainBitmap)).toBe('pixels')
    expect(restorePath(nonTransformable)).toBe('pixels')
  })

  it('不可变换的带图层必须保留像素（恢复端只能靠 putImageData）', () => {
    expect(needsPixelSnapshot(nonTransformable)).toBe(true)
  })

  it('空入参走 pixels（保守：宁可多存也不能少存）', () => {
    expect(restorePath(null)).toBe('pixels')
    expect(restorePath(undefined)).toBe('pixels')
    expect(needsPixelSnapshot(null)).toBe(true)
  })
})

describe('不变量：快照跳过 ⇔ 恢复不读', () => {
  const layers = [base, draw, imported, plainBitmap, nonTransformable, null]

  it('needsPixelSnapshot 与 restorePath 严格互补', () => {
    for (const layer of layers) {
      expect(needsPixelSnapshot(layer)).toBe(restorePath(layer) === 'pixels')
    }
  })

  it('白存像素的只可能是"可重绘"图层，不会漏掉任何需要像素的图层', () => {
    const skipped = layers.filter((l) => !needsPixelSnapshot(l))
    // 本项目里被跳过的应当是原图层/导入图层这类几何重绘图层
    for (const layer of skipped) {
      expect(layer).toBeTruthy()
      expect(layer.image || layer.sourceCanvas).toBeTruthy()
      expect(layer.transformable).toBe(true)
    }
    // 而绘制层（画笔/空白层）永远必须保留像素
    expect(needsPixelSnapshot(draw)).toBe(true)
    expect(needsPixelSnapshot(plainBitmap)).toBe(true)
  })
})
