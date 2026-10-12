import {describe, it, expect} from 'vitest'
import {
  DEFAULT_CONFIG,
  mergeConfig,
  normalizeApiUrl,
  readStoredConfig,
  CONFIG_KEY
} from '../../iwb-cutout-extension/src/shared/config.js'

describe('配置唯一真源', () => {
  it('默认值与 popup/background/content 三方一致', () => {
    expect(DEFAULT_CONFIG).toEqual({
      apiUrl: 'http://localhost:30092',
      crop: true,
      autoConnect: true,
      replaceMode: false,
      autoWhiteBg: false,
      bgSize: 800,
      bgRatio: 0.85,
      bgMode: 'white',
      compressWidth: 1024,
      compressQuality: 80,
      useOriginalImage: true
    })
    expect(CONFIG_KEY).toBe('iwb_cutout_config')
  })

  it('空输入返回默认值', () => {
    expect(mergeConfig()).toEqual(DEFAULT_CONFIG)
    expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(mergeConfig('not-an-object')).toEqual(DEFAULT_CONFIG)
  })

  it('「编辑时加载原图」可关闭，缺省开启', () => {
    expect(mergeConfig({useOriginalImage: false}).useOriginalImage).toBe(false)
    expect(mergeConfig({useOriginalImage: 'yes'}).useOriginalImage).toBe(true)
    expect(mergeConfig().useOriginalImage).toBe(true)
  })

  it('内容占比 500% 会被夹到 1，而不是存成 5（旧实现的真实缺陷）', () => {
    const cfg = mergeConfig({bgRatio: (500 / 100) * 100})
    expect(cfg.bgRatio).toBeLessThanOrEqual(1)
    expect(mergeConfig({bgRatio: 5}).bgRatio).toBe(1)
    expect(mergeConfig({bgRatio: 0}).bgRatio).toBe(0.1)
    expect(mergeConfig({bgRatio: 0.85}).bgRatio).toBe(0.85)
  })

  it('非法数值回落默认、越界数值被夹紧、非数值不产生 NaN', () => {
    expect(mergeConfig({bgSize: 'abc'}).bgSize).toBe(800)
    expect(mergeConfig({bgSize: 10}).bgSize).toBe(64)
    expect(mergeConfig({bgSize: 99999}).bgSize).toBe(4096)
    expect(mergeConfig({compressQuality: 3}).compressQuality).toBe(10)
    expect(mergeConfig({compressQuality: 300}).compressQuality).toBe(100)
    expect(mergeConfig({compressWidth: -5}).compressWidth).toBe(64)
    expect(mergeConfig({bgRatio: 'oops'}).bgRatio).toBe(0.85)
  })

  it('bgMode 只接受 white/transparent', () => {
    expect(mergeConfig({bgMode: 'transparent'}).bgMode).toBe('transparent')
    expect(mergeConfig({bgMode: 'black'}).bgMode).toBe('white')
    expect(mergeConfig({bgMode: undefined}).bgMode).toBe('white')
  })

  it('布尔字段不会被字符串 "false" 之类的东西骗到', () => {
    expect(mergeConfig({crop: false}).crop).toBe(false)
    expect(mergeConfig({crop: 0}).crop).toBe(false)
    expect(mergeConfig({crop: true}).crop).toBe(true)
    expect(mergeConfig({replaceMode: ''}).replaceMode).toBe(false)
  })
})

describe('API 地址归一化', () => {
  it('去掉结尾斜杠，保证 `${api}/rmbg` 拼接正确', () => {
    expect(normalizeApiUrl('http://localhost:30092/')).toBe('http://localhost:30092')
    expect(normalizeApiUrl('http://localhost:30092///')).toBe('http://localhost:30092')
  })

  it('补全协议、丢弃路径与查询串', () => {
    expect(normalizeApiUrl('localhost:30092')).toBe('http://localhost:30092')
    expect(normalizeApiUrl('https://api.example.com/rmbg?x=1')).toBe('https://api.example.com')
    expect(normalizeApiUrl('  http://a.b  ')).toBe('http://a.b')
  })

  it('非 http(s) 或非法值回落默认', () => {
    expect(normalizeApiUrl('ftp://x')).toBe(DEFAULT_CONFIG.apiUrl)
    expect(normalizeApiUrl('::::')).toBe(DEFAULT_CONFIG.apiUrl)
    expect(normalizeApiUrl('')).toBe(DEFAULT_CONFIG.apiUrl)
    expect(normalizeApiUrl(undefined)).toBe(DEFAULT_CONFIG.apiUrl)
  })
})

describe('readStoredConfig', () => {
  it('读到半截存储数据也能补全成完整配置', () => {
    const cfg = readStoredConfig({replaceMode: true})
    expect(cfg.replaceMode).toBe(true)
    expect(cfg.bgSize).toBe(DEFAULT_CONFIG.bgSize)
    expect(Object.keys(cfg).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())
  })

  it('storage 里存了脏数据不会污染运行时配置', () => {
    const cfg = readStoredConfig({bgRatio: 42, apiUrl: null, bgMode: 'red'})
    expect(cfg.bgRatio).toBe(1)
    expect(cfg.apiUrl).toBe(DEFAULT_CONFIG.apiUrl)
    expect(cfg.bgMode).toBe('white')
  })
})
