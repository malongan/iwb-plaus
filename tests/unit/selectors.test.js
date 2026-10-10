// @vitest-environment jsdom
import {describe, it, expect, beforeEach} from 'vitest'
import {SEL, EXT_SEL, byNodeId, probeHost, probeProblems} from '../../iwb-cutout-extension/src/shared/selectors.js'

/** 复刻宿主的关键 DOM 契约 */
function renderHost({breakImageClass = false} = {}) {
  const imgClass = breakImageClass ? 'iwb-ref-renamed' : 'iwb-ref-single'
  document.body.innerHTML = `
    <div class="canvas">
      <div class="iwb-node iwb-node-selected" data-node-id="n1">
        <div class="iwb-node-headbtns"><input type="file"></div>
        <div class="iwb-ref-body"><img class="${imgClass}" src="x.png"></div>
      </div>
      <div class="iwb-node" data-node-id="n2">
        <div class="iwb-ref-body"><div class="iwb-ref-emptybox"><input type="file"></div></div>
      </div>
    </div>
    <div class="iwb-node-floatbar"><button data-tip="添加参考图节点">+</button></div>
  `
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('byNodeId', () => {
  beforeEach(() => renderHost())

  it('按 data-node-id 命中', () => {
    expect(byNodeId('n1')?.getAttribute('data-node-id')).toBe('n1')
    expect(byNodeId('n2')?.getAttribute('data-node-id')).toBe('n2')
  })

  it('空 id / 不存在的 id 返回 null', () => {
    expect(byNodeId('')).toBeNull()
    expect(byNodeId(null)).toBeNull()
    expect(byNodeId('nope')).toBeNull()
  })

  it('id 里的引号被转义，不会把选择器搞坏', () => {
    document.body.innerHTML = '<div data-node-id="a&quot;b"></div>'
    expect(byNodeId('a"b')?.getAttribute('data-node-id')).toBe('a"b')
  })
})

describe('SEL 契约表', () => {
  beforeEach(() => renderHost())

  it('定义的选择器都能被 querySelector 解析（写错选择器会在这里立刻炸）', () => {
    for (const [name, selector] of Object.entries(SEL)) {
      if (name === 'workspacesKey') continue // 是 localStorage 键名，不是选择器
      expect(() => document.querySelector(selector), `${name}: ${selector}`).not.toThrow()
      expect(() => document.querySelectorAll(selector), `${name}: ${selector}`).not.toThrow()
    }
  })

  it('扩展自身选择器同样合法', () => {
    for (const selector of Object.values(EXT_SEL)) {
      expect(() => document.querySelector(selector)).not.toThrow()
    }
  })

  it('fixture 契约能被各选择器识别', () => {
    expect(document.querySelectorAll(SEL.node)).toHaveLength(2)
    expect(document.querySelector(SEL.nodeSelected)).toBeTruthy()
    expect(document.querySelector(SEL.floatbar)).toBeTruthy()
    expect(document.querySelector(SEL.refImage)).toBeTruthy()
    expect(document.querySelector(SEL.emptyBox)).toBeTruthy()
    expect(document.querySelector(SEL.addRefBtn)).toBeTruthy()
    expect(document.querySelector(SEL.headFileInput)).toBeTruthy()
    expect(document.querySelector(SEL.bodyFileInput)).toBeTruthy()
    expect(byNodeId('n1').querySelector(SEL.anyImage)).toBeTruthy()
  })
})

describe('probeHost 自检', () => {
  it('结构正常：图片选择器 ok、画布节点有命中', () => {
    renderHost()
    const results = probeHost(document)
    const image = results.find(r => r.name === '图片选择器')
    const nodes = results.find(r => r.name === '画布节点')
    expect(image.ok).toBe(true)
    expect(image.level).toBe('ok')
    expect(nodes.ok).toBe(true)
    expect(probeProblems(results).filter(p => p.level === 'error')).toHaveLength(0)
  })

  it('宿主改版（有图但类名变了）：报 error，可被 probeProblems 捞出', () => {
    renderHost({breakImageClass: true})
    const results = probeHost(document)
    const image = results.find(r => r.name === '图片选择器')
    expect(image.ok).toBe(false)
    expect(image.level).toBe('error')
    expect(image.detail).toContain('宿主可能改版')
    expect(probeProblems(results).some(p => p.name === '图片选择器')).toBe(true)
  })

  it('页面没有图片节点时跳过图片校验，不误报', () => {
    document.body.innerHTML = '<div class="iwb-node" data-node-id="n1"></div>'
    const results = probeHost(document)
    const image = results.find(r => r.name === '图片选择器')
    expect(image.ok).toBe(true)
    expect(image.detail).toContain('跳过校验')
  })

  it('结果结构稳定：含名称/级别/详情，且 name 不重复', () => {
    renderHost()
    const results = probeHost(document)
    expect(results.length).toBeGreaterThanOrEqual(5)
    for (const r of results) {
      expect(typeof r.name).toBe('string')
      expect(['ok', 'warn', 'error', 'info']).toContain(r.level)
      expect(typeof r.detail).toBe('string')
    }
    const names = results.map(r => r.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
