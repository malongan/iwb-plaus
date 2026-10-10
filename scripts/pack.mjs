#!/usr/bin/env node
/* 打包可分发的 .zip（只含运行时需要的文件，不含源码与测试） */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '..')
const ext = path.join(repo, 'iwb-cutout-extension')

if (!fs.existsSync(path.join(ext, 'dist', 'content.js'))) {
  console.error('[pack] 缺少 dist/，请先 npm run build')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
const out = path.join(repo, `iwb-cutout-extension-v${manifest.version}.zip`)
fs.rmSync(out, {force: true})

// 运行时需要：manifest / popup.html / styles.css / dist / icons
const include = ['manifest.json', 'popup.html', 'styles.css', 'dist', 'icons']
const exclude = ['src/*', 'tests/*', '*.map', '.DS_Store']

try {
  execFileSync('zip', ['-r', '-q', out, ...include, '-x', ...exclude], {cwd: ext, stdio: 'inherit'})
} catch (err) {
  console.error('[pack] zip 命令失败：' + err.message)
  process.exit(1)
}

const kb = (fs.statSync(out).size / 1024).toFixed(1)
console.log(`[pack] ${path.basename(out)} (${kb} KB) — manifest v${manifest.version}`)
