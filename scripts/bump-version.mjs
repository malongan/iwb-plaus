#!/usr/bin/env node
/* 版本号同步：manifest.json 与 package.json 必须一致，标签也必须与 manifest 一致
 *
 *   npm run version:bump -- patch     2.16.1 -> 2.16.2
 *   npm run version:bump -- minor     2.16.1 -> 2.17.0
 *   npm run version:bump -- major     2.16.1 -> 3.0.0
 *   npm run version:bump -- set 3.0.0 直接指定
 *
 * 改完会打印后续需要手工做的两件事（更新日志、打标签），
 * 之前 README/manifest/popup 三处版本各写各的、漂移到 9 个小版本，就是缺这一步。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '..')
const manifestPath = path.join(repo, 'iwb-cutout-extension/manifest.json')
const pkgPath = path.join(repo, 'package.json')

const [, , mode, explicit] = process.argv

function bump(version, kind) {
  const [maj, min, pat] = version.split('.').map((n) => parseInt(n, 10))
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`
  throw new Error(`未知的版本类型: ${kind}`)
}

function assertValid(v) {
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`版本号格式不合法: ${v}（应为 x.y.z）`)
  return v
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

let next
if (mode === 'set') next = assertValid(explicit)
else if (['major', 'minor', 'patch'].includes(mode)) next = assertValid(bump(manifest.version, mode))
else {
  console.error('用法: node scripts/bump-version.mjs <major|minor|patch|set> [x.y.z]')
  process.exit(1)
}

if (manifest.version === pkg.version && next === manifest.version) {
  console.log(`版本未变化: ${next}`)
  process.exit(0)
}

manifest.version = next
pkg.version = next
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

console.log(`[version] manifest.json + package.json -> v${next}`)
console.log('接下来：')
console.log(`  1. 在 iwb-cutout-extension/README.md 的「更新日志」顶部补一条 v${next}`)
console.log('  2. npm run verify')
console.log(`  3. git add -A && git commit -m "release: v${next}" && git tag -a v${next} -m "..."`)
