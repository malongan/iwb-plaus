/* 图层恢复路径判定 —— 快照端与恢复端共用的唯一真源

 * 快照端（editor.js snapshotState）用它决定"要不要拍这份像素"，
 * 恢复端（editor.js restoreState）用它决定"要不要读这份像素"。
 * 两边必须永远一致，否则会出现"快照没拍、恢复却要读"的数据丢失。
 */

/**
 * 绘制类图层（画笔标注 / 空白图层）：非原图、且没有绑定图片的光栅层
 * @param {{id?:string, image?:unknown}} layer
 */
export function isDrawableLayer(layer) {
  return !!layer && layer.id !== 'base' && !layer.image
}

/**
 * 恢复该图层时走哪条路径
 *   'redraw'：按 image/sourceCanvas 几何重绘，快照里的 bm.data 永远不会被读取
 *             —— 这类图层的像素是白存的字节（通常是最大的原图层）
 *   'pixels'：依赖 putImageData(bm.data)，快照必须保留像素
 *
 * 注意 sourceCanvas 的语义：恢复流程对绘制类图层会先清空 sourceCanvas，
 * 因此这里对 drawable 图层一律按"没有 sourceCanvas"处理。
 *
 * @param {{id?:string, image?:unknown, sourceCanvas?:unknown, transformable?:boolean}} layer
 * @returns {'redraw'|'pixels'}
 */
export function restorePath(layer) {
  if (!layer) return 'pixels'
  const sourceCanvas = isDrawableLayer(layer) ? null : layer.sourceCanvas
  if (layer.transformable && (layer.image || sourceCanvas)) return 'redraw'
  return 'pixels'
}

/**
 * 快照是否可以跳过该图层的像素
 * 与 restorePath 完全等价，单独命名是为了让快照端的意图更直白。
 */
export function needsPixelSnapshot(layer) {
  return restorePath(layer) === 'pixels'
}
