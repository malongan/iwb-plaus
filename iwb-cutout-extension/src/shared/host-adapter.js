/* 宿主适配层：本扩展与"生图工作台"页面 DOM 打交道的全部原语
 *
 * 分层约定：
 *   - 本文件只做"怎么跟宿主 DOM 说话"（读节点、找 input、写文件、探测结构），
 *     不碰 chrome.*、不弹 toast、不决定业务流程；
 *   - content.js 负责编排业务（抠图 API、白底合成、提示与降级链路），
 *     需要宿主能力时一律通过这里。
 * 这样宿主改版时要动的东西被压缩到 selectors.js（选择器）+ 本文件（结构语义）。
 *
 * 全部函数接受可选的 doc/localStorage 参数，默认取全局，方便 jsdom 单测。
 */

import { SEL, byNodeId, probeHost, probeProblems } from './selectors.js'

/** 当前选中的节点（优先） */
export function getSelectedNode(doc = document) {
  return doc.querySelector(SEL.nodeSelected)
}

/** 按 id 找节点 */
export function getNodeById(nodeId, doc = document) {
  return byNodeId(nodeId, doc)
}

/**
 * 点击节点时应作用于哪个节点：优先"当前选中"，其次按 id 回查，最后回落传入节点
 * （气泡栏/工具条会被宿主复用，直接用闭包里的旧节点会操作错对象）
 */
export function resolveLiveNode(nodeId, fallback, doc = document) {
  return getSelectedNode(doc) || getNodeById(nodeId, doc) || fallback || null
}

/** 读取节点里的图片（data: 直接可用；blob: 需要转换；http(s) 需要下载/绘制） */
export function getNodeImage(nodeEl) {
  if (!nodeEl) return null
  const img = nodeEl.querySelector(SEL.refImage) || nodeEl.querySelector(SEL.outImage)
  if (!img) return null
  const src = img.currentSrc || img.src
  if (!src) return null
  if (src.startsWith('data:')) return { base64: src }
  if (src.startsWith('blob:')) return { blobUrl: src }
  return { url: src }
}

/** 节点是否带图片（ref 有图 / out 输出图；不含 prompt/llm 等缩略图） */
export function hasImage(nodeEl) {
  return !!(nodeEl && nodeEl.querySelector(SEL.anyImage))
}

/** 是否空参考图节点（有上传框、没图片） */
export function isEmptyRefNode(nodeEl) {
  if (!nodeEl) return false
  return !!(nodeEl.querySelector(SEL.emptyBox) || (nodeEl.querySelector(SEL.refBody) && !nodeEl.querySelector(SEL.refImage)))
}

/** 节点图片的文件名：从宿主存的 workspace 数据里取，取不到回落 'image' */
export function getNodeFileName(nodeEl, storage = globalThis.localStorage) {
  if (!nodeEl) return 'image'
  try {
    const raw = storage && storage.getItem(SEL.workspacesKey)
    const wsData = JSON.parse(raw || '{}')
    const ws = (wsData.workspaces || []).find((w) => w.id === (wsData.activeId || wsData.workspaces?.[0]?.id))
    const nodeId = nodeEl.getAttribute('data-node-id')
    const node = (ws?.nodes || []).find((n) => n.id === nodeId)
    return node?.data?.name || 'image'
  } catch {
    return 'image'
  }
}

/** "添加参考图"按钮（新建节点模式依赖） */
export function getAddRefButton(doc = document) {
  return doc.querySelector(SEL.addRefBtn)
}

/**
 * 找节点上可用于写入结果的 file input
 * @param {Element} nodeEl
 * @param {{allowAny?: boolean}} [opts] allowAny：都找不到时退回"任意 file input"
 *        （宿主新建的空节点结构不固定，原实现就是按任意 file input 找的）
 * @returns {'head'|'body'|'any'|null}
 */
export function findFileInput(nodeEl, opts = {}) {
  if (!nodeEl) return null
  if (nodeEl.querySelector(SEL.headFileInput)) return 'head'
  if (nodeEl.querySelector(SEL.bodyFileInput)) return 'body'
  if (opts.allowAny && nodeEl.querySelector('input[type="file"]')) return 'any'
  return null
}

/** 取出上一步找到的 file input 元素 */
export function getFileInput(nodeEl, kind) {
  if (!nodeEl || !kind) return null
  if (kind === 'head') return nodeEl.querySelector(SEL.headFileInput)
  if (kind === 'body') return nodeEl.querySelector(SEL.bodyFileInput)
  if (kind === 'any') return nodeEl.querySelector('input[type="file"]')
  return null
}

/**
 * 把 File 写进宿主的 <input type=file> 并派发 change —— 走宿主自己的 onChange，
 * 从而让宿主的 React 状态正确更新（不这样做状态会不同步）
 * @returns {boolean} 是否写入成功
 */
export function writeFileToInput(input, file) {
  if (!input || !file || typeof DataTransfer === 'undefined') return false
  try {
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  } catch {
    return false
  }
}

/**
 * 直接把结果写回节点（优先头部 input，其次 body input）
 * @param {{allowAny?: boolean}} [opts] 见 findFileInput
 */
export function writeFileToNode(nodeEl, file, opts = {}) {
  const kind = findFileInput(nodeEl, opts)
  if (!kind) return false
  return writeFileToInput(getFileInput(nodeEl, kind), file)
}

/**
 * 等待宿主创建出"新出现的空节点"
 * @param {Element[]} existing 必须在触发创建【之前】采集 —— 事后采集会把
 *        同步创建的节点误判为"本来就有"，导致超时
 */
export function waitForNewNode(existing, timeout = 2000, doc = document) {
  const before = Array.isArray(existing) ? existing : Array.from(doc.querySelectorAll(SEL.node))
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      for (const node of doc.querySelectorAll(SEL.node)) {
        if (!node.querySelector(SEL.refImage) && !before.includes(node)) {
          resolve(node)
          return
        }
      }
      if (Date.now() - start > timeout) resolve(null)
      // 定时器而非 rAF：后台/离屏标签页里 rAF 可能被完全暂停
      else setTimeout(check, 50)
    }
    check()
  })
}

/** 采集当前已有节点（必须在触发创建之前调用） */
export function snapshotNodes(doc = document) {
  return Array.from(doc.querySelectorAll(SEL.node))
}

/** 宿主 DOM 契约自检（供启动告警与 popup「自检」共用） */
export function probe(doc = document) {
  return probeHost(doc)
}

/** 自检中的致命问题（error 级） */
export function fatalProblems(doc = document) {
  return probeProblems(probe(doc)).filter((p) => p.level === 'error')
}
