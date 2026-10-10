// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest'
import {
  getSelectedNode,
  getNodeById,
  resolveLiveNode,
  getNodeImage,
  hasImage,
  isEmptyRefNode,
  getNodeFileName,
  getAddRefButton,
  findFileInput,
  getFileInput,
  writeFileToInput,
  writeFileToNode,
  snapshotNodes,
  waitForNewNode,
  fatalProblems
} from '../../iwb-cutout-extension/src/shared/host-adapter.js'

function renderHost({imgSrc = 'data:image/png;base64,AAAA', withFile = true, empty = false} = {}) {
  document.body.innerHTML = `
    <div class="iwb-node iwb-node-selected" data-node-id="n1">
      ${withFile ? '<div class="iwb-node-headbtns"><input type="file"></div>' : ''}
      <div class="iwb-ref-body">${imgSrc ? `<img class="iwb-ref-single" src="${imgSrc}">` : ''}</div>
    </div>
    <div class="iwb-node" data-node-id="n2">
      <div class="iwb-ref-body">${empty ? '<div class="iwb-ref-emptybox"><input type="file"></div>' : ''}</div>
    </div>
    <button data-tip="添加参考图节点">+</button>
  `
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('节点定位', () => {
  beforeEach(() => renderHost())

  it('优先取选中节点，其次按 id 回查', () => {
    expect(getSelectedNode()?.dataset.nodeId ?? getSelectedNode()?.getAttribute('data-node-id')).toBe('n1')
    expect(getNodeById('n2')?.getAttribute('data-node-id')).toBe('n2')
    expect(resolveLiveNode('n2', null)?.getAttribute('data-node-id')).toBe('n1') // 选中优先
    document.querySelector('.iwb-node').classList.remove('iwb-node-selected')
    expect(resolveLiveNode('n2', null)?.getAttribute('data-node-id')).toBe('n2')
    expect(resolveLiveNode('nope', null)).toBeNull()
  })

  it('能找到「添加参考图」按钮', () => {
    expect(getAddRefButton()).toBeTruthy()
  })
})

describe('读取节点图片', () => {
  it('data: / blob: / http(s) 三种来源分别归类', () => {
    renderHost({imgSrc: 'data:image/png;base64,AAAA'})
    expect(getNodeImage(document.querySelector('[data-node-id="n1"]'))).toEqual({base64: 'data:image/png;base64,AAAA'})

    renderHost({imgSrc: 'blob:http://x/uuid'})
    expect(getNodeImage(document.querySelector('[data-node-id="n1"]'))).toEqual({blobUrl: 'blob:http://x/uuid'})

    renderHost({imgSrc: 'https://cdn.example.com/a.png'})
    expect(getNodeImage(document.querySelector('[data-node-id="n1"]'))).toEqual({url: 'https://cdn.example.com/a.png'})
  })

  it('没有图片返回 null', () => {
    renderHost({imgSrc: ''})
    expect(getNodeImage(document.querySelector('[data-node-id="n1"]'))).toBeNull()
    expect(getNodeImage(null)).toBeNull()
  })
})

describe('节点形态判定', () => {
  it('hasImage / isEmptyRefNode', () => {
    renderHost({empty: true})
    const withImage = document.querySelector('[data-node-id="n1"]')
    const emptyNode = document.querySelector('[data-node-id="n2"]')
    expect(hasImage(withImage)).toBe(true)
    expect(hasImage(emptyNode)).toBe(false)
    expect(isEmptyRefNode(emptyNode)).toBe(true)
    expect(isEmptyRefNode(withImage)).toBe(false)
    expect(hasImage(null)).toBe(false)
    expect(isEmptyRefNode(null)).toBe(false)
  })
})

describe('节点文件名', () => {
  beforeEach(() => renderHost())

  const storageFor = value => ({getItem: () => value})

  it('从宿主 workspace 数据里取文件名', () => {
    const data = JSON.stringify({
      activeId: 'w1',
      workspaces: [{id: 'w1', nodes: [{id: 'n1', data: {name: 'product.png'}}]}]
    })
    expect(getNodeFileName(document.querySelector('[data-node-id="n1"]'), storageFor(data))).toBe('product.png')
  })

  it('取不到 / 结构不对 / 存储报错 → 回落 image（不抛异常）', () => {
    const node = document.querySelector('[data-node-id="n1"]')
    expect(getNodeFileName(node, storageFor(null))).toBe('image')
    expect(getNodeFileName(node, storageFor('{坏 JSON'))).toBe('image')
    expect(
      getNodeFileName(node, {
        getItem: () => {
          throw new Error('denied')
        }
      })
    ).toBe('image')
    expect(getNodeFileName(node, null)).toBe('image')
    expect(getNodeFileName(null)).toBe('image')
  })
})

describe('file input 写入', () => {
  it('识别头部与 body 的 file input', () => {
    renderHost({empty: true})
    const withImage = document.querySelector('[data-node-id="n1"]')
    const emptyNode = document.querySelector('[data-node-id="n2"]')
    expect(findFileInput(withImage)).toBe('head')
    expect(findFileInput(emptyNode)).toBe('body')
    expect(findFileInput(null)).toBeNull()
    expect(getFileInput(withImage, 'head')).toBeTruthy()
    expect(getFileInput(withImage, 'body')).toBeNull()
    expect(getFileInput(null, 'head')).toBeNull()
  })

  it('jsdom 没有 DataTransfer 时安全返回 false（真实写入由 e2e 覆盖）', () => {
    renderHost()
    const input = document.querySelector('input[type=file]')
    expect(writeFileToInput(input, {name: 'a.png'})).toBe(false)
    expect(writeFileToInput(null, {name: 'a.png'})).toBe(false)
    expect(writeFileToNode(document.querySelector('[data-node-id="n1"]'), {name: 'a.png'})).toBe(false)
  })
})

describe('等待宿主新建节点', () => {
  beforeEach(() => renderHost())

  it('在触发创建之前采集快照，新节点能被识别', async () => {
    const before = snapshotNodes()
    expect(before).toHaveLength(2)
    // 模拟宿主"同步创建"
    const n = document.createElement('div')
    n.className = 'iwb-node'
    n.setAttribute('data-node-id', 'n3')
    n.innerHTML = '<div class="iwb-ref-body"><div class="iwb-ref-emptybox"><input type="file"></div></div>'
    document.body.appendChild(n)

    const created = await waitForNewNode(before, 500)
    expect(created?.getAttribute('data-node-id')).toBe('n3')
  })

  it('如果把新节点也算进 existing（旧实现的缺陷），会一直等不到 → 超时返回 null', async () => {
    const n = document.createElement('div')
    n.className = 'iwb-node'
    n.setAttribute('data-node-id', 'n3')
    document.body.appendChild(n)
    const wrongBefore = snapshotNodes() // 已经包含 n3
    const created = await waitForNewNode(wrongBefore, 150)
    expect(created).toBeNull()
  })

  it('始终没有新节点时超时返回 null', async () => {
    const before = snapshotNodes()
    expect(await waitForNewNode(before, 120)).toBeNull()
  })
})

describe('自检透传', () => {
  it('fatalProblems 只捞 error 级问题', () => {
    renderHost()
    expect(fatalProblems(document)).toHaveLength(0)

    // 把图片类名改掉，模拟宿主改版
    document.querySelectorAll('img').forEach(img => {
      img.className = 'iwb-ref-renamed'
    })
    const fatal = fatalProblems(document)
    expect(fatal).toHaveLength(1)
    expect(fatal[0].name).toBe('图片选择器')
    expect(fatal[0].level).toBe('error')
  })
})

// vi 保持被引用，避免 lint 报未使用（后续扩展可直接用 fake timer）
void vi
