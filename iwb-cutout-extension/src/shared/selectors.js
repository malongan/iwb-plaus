/* 宿主（生图工作台）DOM 契约的唯一定义
 *
 * 这些选择器是本扩展对宿主页面的全部依赖——宿主一改版就会静默失效
 * （表现为"按钮不出现"或"未找到图片"）。集中到这一个文件后：
 *   1. 改版时只需改这里；
 *   2. probe() 能逐项自检，断裂时给用户明确告警而不是静默失败。
 */

export const SEL = {
  /** 画布节点 */
  node: '.iwb-node[data-node-id]',
  /** 当前选中的节点 */
  nodeSelected: '.iwb-node.iwb-node-selected[data-node-id]',
  /** 应用自绘的浮动气泡栏（本扩展按钮的定位参照物） */
  floatbar: '.iwb-node-floatbar',

  /** 参考图节点里的图片 */
  refImage: 'img.iwb-ref-single, .iwb-ref-single img, .iwb-ref-show img',
  /** 输出/结果节点里的图片 */
  outImage: 'img.iwb-out-cell-img, .iwb-out-cell-img img, img.iwb-result-thumb, .iwb-result-thumb img',
  /** 任意节点里"有图片"的判定 */
  anyImage: '.iwb-ref-single, .iwb-ref-body .iwb-ref-show img, .iwb-out-cell-img, .iwb-result-thumb',

  /** 空参考图节点 */
  emptyBox: '.iwb-ref-emptybox',
  refBody: '.iwb-ref-body',

  /** 注入结果的三类 file input */
  headFileInput: '.iwb-node-headbtns input[type="file"]',
  bodyFileInput: '.iwb-ref-emptybox input[type="file"], .iwb-ref-upload input[type="file"]',

  /** 工具栏"添加参考图节点"按钮（新建节点模式依赖它） */
  addRefBtn: '[data-tip*="参考图节点"], [data-tip*="参考图"]',

  /** 本扩展注入的按钮类名（用于清理/打处理中标记） */
  extButtons: '.iwb-cutout-btn, .iwb-whitebg-btn, .iwb-compress-btn, .iwb-editor-btn-icon',

  /** 宿主存工作区数据的 localStorage 键（读取节点文件名用） */
  workspacesKey: 'iwb_web_workspaces'
}

/** 按 data-node-id 找节点（调用处不再手拼属性选择器） */
export function byNodeId(nodeId, doc = document) {
  if (!nodeId) return null
  return doc.querySelector(`[data-node-id="${String(nodeId).replace(/"/g, '\\"')}"]`)
}

/** 扩展自身的编辑器遮罩（不属于宿主契约，放这里只为集中引用） */
export const EXT_SEL = {
  editorOverlay: '#iwb-editor-overlay',
  toolbar: '#iwb-cutout-toolbar',
  overlay: '#iwb-cutout-overlay'
}

/**
 * 逐项自检宿主 DOM 契约。
 * @param {Document} [doc]
 * @returns {{name:string, ok:boolean, level:'error'|'warn'|'info', detail:string}[]}
 */
export function probeHost(doc = document) {
  const out = []
  const push = (name, ok, level, detail) => out.push({ name, ok, level, detail })

  const nodes = doc.querySelectorAll(SEL.node)
  push('画布节点', nodes.length > 0, nodes.length > 0 ? 'info' : 'warn',
    nodes.length ? `找到 ${nodes.length} 个节点` : '页面上没有 .iwb-node（可能未进入画布页）')

  const selected = doc.querySelectorAll(SEL.nodeSelected)
  push('选中节点', true, 'info', selected.length ? '存在选中节点' : '当前无选中节点')

  push('浮动气泡栏', !!doc.querySelector(SEL.floatbar), 'info',
    doc.querySelector(SEL.floatbar) ? '存在 .iwb-node-floatbar' : '当前无气泡栏（未选中节点时正常）')

  // 图片选择器：只要有 <img> 却一个都匹配不上，说明宿主改了类名 —— 这是关键失效信号
  const anyImgCount = nodes.length
    ? Array.from(nodes).filter((n) => n.querySelector('img')).length
    : 0
  const refMatchCount = nodes.length
    ? Array.from(nodes).filter((n) => n.querySelector(SEL.refImage) || n.querySelector(SEL.outImage)).length
    : 0
  if (anyImgCount === 0) {
    push('图片选择器', true, 'info', '当前没有含图节点，跳过校验')
  } else {
    push('图片选择器', refMatchCount > 0, refMatchCount > 0 ? 'ok' : 'error',
      refMatchCount > 0
        ? `${refMatchCount}/${anyImgCount} 个含图节点可被识别`
        : `发现 ${anyImgCount} 个含图节点但选择器一个都没匹配 —— 宿主可能改版`)
  }

  push('新建节点按钮', !!doc.querySelector(SEL.addRefBtn), 'info',
    doc.querySelector(SEL.addRefBtn) ? '找到添加参考图按钮' : '未找到添加参考图按钮（新建节点模式将回退为粘贴）')

  let lsOk = false
  try {
    lsOk = !!window.localStorage.getItem(SEL.workspacesKey)
  } catch {
    lsOk = false
  }
  push('工作区数据', lsOk, lsOk ? 'info' : 'warn',
    lsOk ? 'localStorage 键存在（文件名可读取）' : `未找到 ${SEL.workspacesKey}，节点文件名将回落为 image`)

  return out
}

/** 自检里所有 error/warn 级问题（用于一次性告警） */
export function probeProblems(results) {
  return results.filter((r) => !r.ok && (r.level === 'error' || r.level === 'warn'))
}
