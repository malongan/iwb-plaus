#!/usr/bin/env node
/* 构建脚本
 *
 * 默认：打包 src/ -> iwb-cutout-extension/dist/（可直接「加载已解压的扩展程序」）
 * --e2e：额外组装 build/e2e-ext/（把 content script 的 matches 扩到 localhost，
 *        供 Playwright 冒烟测试在本地 fixture 页面上注入）
 */
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '..')
const ext = path.join(repo, 'iwb-cutout-extension')
const e2e = process.argv.includes('--e2e')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: path.join(ext, 'src/entries/background.js'),
    content: path.join(ext, 'src/entries/content.js'),
    popup: path.join(ext, 'src/entries/popup.js')
  },
  outdir: path.join(ext, 'dist'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  legalComments: 'none',
  logLevel: 'info'
}

/** 组装 e2e 用的解压扩展目录：manifest 的 matches 放宽到 localhost */
function assembleE2e() {
  const out = path.join(repo, 'build/e2e-ext')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })

  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
  manifest.content_scripts[0].matches = [
    'https://iwb.maqiart.eu.org/*',
    'http://localhost/*',
    'http://127.0.0.1/*'
  ]
  manifest.host_permissions = (manifest.host_permissions || []).concat([
    'http://localhost/*',
    'http://127.0.0.1/*'
  ])
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))

  for (const item of ['popup.html', 'styles.css']) {
    fs.copyFileSync(path.join(ext, item), path.join(out, item))
  }
  fs.cpSync(path.join(ext, 'icons'), path.join(out, 'icons'), { recursive: true })
  fs.cpSync(path.join(ext, 'dist'), path.join(out, 'dist'), { recursive: true })
  console.log('[build] e2e extension -> build/e2e-ext/')
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('[build] watching src/ ...')
} else {
  const result = await build({ ...options, metafile: true })
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
  console.log(`[build] ok -> iwb-cutout-extension/dist/ (${(bytes / 1024).toFixed(1)} KB)`)
  if (e2e) assembleE2e()
}
