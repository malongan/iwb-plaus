/* dom.js - 编辑器 DOM 构建与图片加载
 * 节：DOM 创建、图片加载。
 * createEl 负责创建遮罩根节点并写入 runtime.el，随后把各 canvas/面板
 * 引用挂到 S 上；open() 依赖它保证 el 只创建一次。
 */

'use strict'

import { S, runtime } from './state.js'
import { bindEvents } from './events.js'


  // ============ DOM 创建 ============
  export function createEl() {
    if (runtime.el) return
    runtime.el = document.createElement('div')
    runtime.el.id = 'iwb-editor-overlay'
    runtime.el.className = 'iwb-editor-overlay'
    runtime.el.innerHTML = `
      <div class="iwb-editor-modal">
        <div class="iwb-editor-header">
          <span class="iwb-editor-title">图片编辑</span>
          <div class="iwb-editor-history">
            <button class="iwb-editor-action" data-action="undo" title="撤销 (Ctrl+Z)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
            <button class="iwb-editor-action" data-action="redo" title="重做 (Ctrl+Shift+Z)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
            <button class="iwb-editor-action" data-action="reset" title="清空标注"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            <button class="iwb-editor-action iwb-editor-action-restore" data-action="restore" title="复原原始图（撤销所有编辑）"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></button>
          </div>
          <div class="iwb-editor-tools">
            <button class="iwb-editor-tool" data-tool="select" title="选择/移动：点击元素选中，拖拽移动，手柄调整大小，双击文字改内容"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg></button>

            <button class="iwb-editor-tool active" data-tool="brush" title="画笔"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>

            <button class="iwb-editor-tool" data-tool="eraser" title="橡皮：擦除当前活跃图层的内容（画笔标注或原图），与画笔共用大小/硬度/透明度"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg></button>

            <button class="iwb-editor-tool" data-tool="pen" title="钢笔：点击添加节点，双击或 Enter 完成自定义形状"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg></button>

            <button class="iwb-editor-tool" data-tool="text" title="文字"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 3 20 3 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="3" x2="12" y2="20"/></svg></button>

            <button class="iwb-editor-tool" data-tool="rect" title="矩形框"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></button>

            <button class="iwb-editor-tool" data-tool="circle" title="圆形"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg></button>

            <button class="iwb-editor-tool" data-tool="arrow" title="箭头"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>

            <button class="iwb-editor-tool" data-tool="picker" title="吸管：点击画布取色（悬停预览），取色后自动切回上一工具"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3Z"/></svg></button>

            <button class="iwb-editor-tool" data-tool="hand" title="抓手：拖拽自由移动画布（任意工具下按住空格或鼠标中键也可平移）"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 10a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg></button>

            <span class="iwb-editor-divider"></span>

            <button class="iwb-editor-tool" data-tool="crop" title="裁剪"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/></svg></button>

            <span class="iwb-editor-divider"></span>

            <button class="iwb-editor-fill-btn" data-action="toggleFill" title="矩形实心填充开关（选中矩形时切换即时生效）">实心</button>
          </div>
          <span class="iwb-editor-divider"></span>

          <div class="iwb-editor-export-actions">
            <button class="iwb-editor-btn iwb-editor-btn-new" data-action="newNode">新建</button>
            <button class="iwb-editor-btn iwb-editor-btn-replace" data-action="replace">覆盖</button>
            <button class="iwb-editor-btn iwb-editor-btn-cancel" data-action="cancel">退出</button>
          </div>
        </div>
        <div class="iwb-editor-main">

          <div class="iwb-editor-layer-panel">
            <div class="iwb-editor-layer-panel-header">
              <span class="iwb-editor-layer-panel-title">图层</span>
              <div class="iwb-editor-layer-add-group">
                <button class="iwb-editor-layer-add-btn" data-action="addBitmapLayer" title="导入图片为新图层"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></button>
                <button class="iwb-editor-layer-add-btn" data-action="addBlankLayer" title="新建空白图层"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></button>
              </div>
            </div>

          <div class="iwb-editor-layer-group" title="调整选中元素的图层顺序">
              <span class="iwb-editor-constraint-label">图层</span>
              <button class="iwb-editor-layer-btn" data-layer="top" title="置顶：选中元素移到最上层 (Ctrl+Shift+])"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="5" x2="20" y2="5"/><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="up" title="上移一层 (Ctrl+])"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="down" title="下移一层 (Ctrl+[)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg></button>
              <button class="iwb-editor-layer-btn" data-layer="bottom" title="置底：选中元素移到最下层 (Ctrl+Shift+[)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/><line x1="4" y1="19" x2="20" y2="19"/></svg></button>
            </div>
          <div class="iwb-editor-layer-list"></div>
          </div>
          <div class="iwb-editor-canvas-wrap">
            <div class="iwb-editor-canvas-stack">
              <div class="iwb-editor-transparency-grid"></div>
               <!-- 位图图层 canvas 动态插入此处 -->
              <canvas class="iwb-editor-stroke"></canvas>
              <canvas class="iwb-editor-text"></canvas>
              <canvas class="iwb-editor-crop-overlay"></canvas>
            </div>
            <input class="iwb-editor-text-input" type="text" placeholder="输入文字，Enter确认，Esc取消">
            <div class="iwb-editor-picker-tip"><span class="iwb-editor-picker-chip"></span><span class="iwb-editor-picker-hex">#ffffff</span></div>
            <div class="iwb-editor-crop-bar">
              <div class="iwb-editor-crop-row"><div class="iwb-editor-constraint-group">
                <span class="iwb-editor-constraint-label">比例</span>
                <button class="iwb-editor-constraint-btn active" data-ratio="free">自由</button>
                <button class="iwb-editor-constraint-btn" data-ratio="1:1">1:1</button>
                <button class="iwb-editor-constraint-btn" data-ratio="4:3">4:3</button>
                <button class="iwb-editor-constraint-btn" data-ratio="3:4">3:4</button>
                <button class="iwb-editor-constraint-btn" data-ratio="16:9">16:9</button>
                <button class="iwb-editor-constraint-btn" data-ratio="9:16">9:16</button>
              </div></div>
              <div class="iwb-editor-crop-row"><div class="iwb-editor-constraint-group">
                <span class="iwb-editor-constraint-label">尺寸</span>
                <input class="iwb-editor-size-input iwb-editor-size-w" type="number" min="1" placeholder="宽" value="800">
                <span class="iwb-editor-size-x">×</span>
                <input class="iwb-editor-size-input iwb-editor-size-h" type="number" min="1" placeholder="高" value="800">
                <button class="iwb-editor-constraint-btn iwb-editor-size-toggle" data-action="toggleSizeConstraint" aria-pressed="false">启用尺寸</button>
                 <button class="iwb-editor-constraint-btn iwb-editor-size-apply" data-action="applySize">应用</button>
              </div></div>
              <div class="iwb-editor-crop-row iwb-editor-crop-actions"><span class="iwb-editor-crop-info">--</span>
              <button class="iwb-editor-crop-confirm" data-action="confirmCrop">✓ 确认</button>
              <button class="iwb-editor-crop-cancel" data-action="cancelCrop">✗ 取消</button>
            </div>
                </div>
            </div>
            <div class="iwb-editor-zoom-hint">滚轮缩放 · 抓手/空格/中键拖拽自由移动画布</div>

        <aside class="iwb-editor-left">
          <div class="iwb-editor-color-panel"><div class="iwb-editor-color-panel-title">调色板</div><div class="iwb-editor-color-picker2"><div class="iwb-color-sv"><span></span></div><div class="iwb-color-hue"><span></span></div></div><div class="iwb-editor-color-fields"><button type="button" class="iwb-editor-color-eye" data-action="palettePick" title="吸色：点击后在画布取样"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3Z"/></svg></button><input class="iwb-editor-color-hex-input" value="#ff4444" maxlength="7"></div><div class="iwb-editor-color-swatches"><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff4444" style="background:#ff4444" title="#ff4444"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff8800" style="background:#ff8800" title="#ff8800"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffd400" style="background:#ffd400" title="#ffd400"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#44dd44" style="background:#44dd44" title="#44dd44"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#00bfa5" style="background:#00bfa5" title="#00bfa5"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#4488ff" style="background:#4488ff" title="#4488ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#aa44ff" style="background:#aa44ff" title="#aa44ff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ff66aa" style="background:#ff66aa" title="#ff66aa"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#ffffff" style="background:#ffffff" title="#ffffff"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#b8b8b8" style="background:#b8b8b8" title="#b8b8b8"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#555555" style="background:#555555" title="#555555"></button><button type="button" class="iwb-editor-color-panel-swatch" data-panel-color="#000000" style="background:#000000" title="#000000"></button></div></div>
          <div class="iwb-editor-params">
          <label class="iwb-editor-brush-label">描边
              <input type="range" class="iwb-editor-brush-size" min="1" max="300" value="3">
              <input type="number" class="iwb-editor-brush-num" min="1" max="300" step="1" value="3" title="输入精确笔刷大小（1~300）">
            </label>
            <div class="iwb-editor-brush-presets" aria-label="描边快捷值">
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="2" title="描边 2"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="4" title="描边 4"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="8" title="描边 8"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="12" title="描边 12"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="16" title="描边 16"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="24" title="描边 24"><i></i></button>
              <button type="button" class="iwb-editor-brush-preset" data-brush-size="32" title="描边 32"><i></i></button>
            </div>
            <div class="iwb-editor-brush-group">
              <label class="iwb-editor-brush-label">硬度
                <input type="range" class="iwb-editor-brush-hardness" min="0" max="100" value="100">
                <span class="iwb-editor-brush-hardness-val">100</span>
              </label>
              <label class="iwb-editor-brush-label iwb-editor-opacity-label">透明
                <input type="range" class="iwb-editor-brush-opacity" min="5" max="100" step="5" value="100">
                <span class="iwb-editor-brush-opacity-val">100%</span>
              </label>
            </div>

          </div>

          <div class="iwb-editor-zoom">
              <button class="iwb-editor-zoom-btn" data-action="zoomOut" title="缩小 (滚轮向下)">−</button>
              <span class="iwb-editor-zoom-val" title="滚轮缩放">100%</span>
              <button class="iwb-editor-zoom-btn" data-action="zoomIn" title="放大 (滚轮向上)">＋</button>
              <button class="iwb-editor-zoom-btn iwb-editor-zoom-fit" data-action="zoomFit" title="适应窗口">适应</button>
            </div>
        </aside>
        </div>

        </div>
        <div class="iwb-editor-footer">

        </div>
      </div>
    `
    document.body.appendChild(runtime.el)

    S.canvasWrap = runtime.el.querySelector('.iwb-editor-canvas-wrap')
    S.canvasStack = runtime.el.querySelector('.iwb-editor-canvas-stack')
    S.transparencyGrid = runtime.el.querySelector('.iwb-editor-transparency-grid')
    S.textCanvas = runtime.el.querySelector('.iwb-editor-text')
    S.strokeCanvas = runtime.el.querySelector('.iwb-editor-stroke')
    S.overlayCanvas = runtime.el.querySelector('.iwb-editor-crop-overlay')
    S.textCtx = S.textCanvas.getContext('2d')
    S.strokeCtx = S.strokeCanvas.getContext('2d')
    S.overlayCtx = S.overlayCanvas.getContext('2d')

    bindEvents()
  }

  // ============ 图片加载 ============
  export function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('图片加载失败'))
      img.src = src
    })
  }
