import { describe, it, expect } from 'vitest'
import {
  CARD_DATA_MAX_BYTES,
  CARD_MAX_BYTES,
  CARD_MAX_PER_MESSAGE,
  CARD_SUMMARY_MAX_CHARS,
  byteLength,
  parseCardTitle,
  validateCardSubmitPayload,
  deriveRepliedCardIds,
  buildCardReplyBody,
} from './html-card'

describe('parseCardTitle（围栏 meta 解析）', () => {
  it('提取 title="..."', () => {
    expect(parseCardTitle('title="方案对比 · 消息渲染架构"')).toBe('方案对比 · 消息渲染架构')
  })

  it('info string 原样透传场景：title 前有其他内容也能提取', () => {
    expect(parseCardTitle('foo=1 title="报告"')).toBe('报告')
  })

  it('title 含引号时截断到首个引号', () => {
    expect(parseCardTitle('title="方案 "B" 对比"')).toBe('方案 ')
  })

  it('无 title 或空 title 返回 null', () => {
    expect(parseCardTitle('')).toBe(null)
    expect(parseCardTitle(null)).toBe(null)
    expect(parseCardTitle(undefined)).toBe(null)
    expect(parseCardTitle('title=""')).toBe(null)
    expect(parseCardTitle('something else')).toBe(null)
  })
})

describe('validateCardSubmitPayload（提交 payload 校验）', () => {
  it('合法 payload 通过（带 data / 不带 data）', () => {
    expect(validateCardSubmitPayload({ summary: '选择了方案 B', data: { choice: 'B' } }).ok).toBe(true)
    expect(validateCardSubmitPayload({ summary: '确认' }).ok).toBe(true)
  })

  it('summary 空 / 非字符串 / 超限被拒绝', () => {
    expect(validateCardSubmitPayload({ summary: '' }).ok).toBe(false)
    expect(validateCardSubmitPayload({ summary: '   ' }).ok).toBe(false)
    expect(validateCardSubmitPayload({ summary: 42 }).ok).toBe(false)
    expect(validateCardSubmitPayload({ summary: 'x'.repeat(CARD_SUMMARY_MAX_CHARS + 1) }).ok).toBe(false)
    expect(validateCardSubmitPayload({ summary: 'x'.repeat(CARD_SUMMARY_MAX_CHARS) }).ok).toBe(true)
  })

  it('payload 非对象被拒绝', () => {
    expect(validateCardSubmitPayload(null).ok).toBe(false)
    expect(validateCardSubmitPayload('str').ok).toBe(false)
    expect(validateCardSubmitPayload(undefined).ok).toBe(false)
  })

  it('data 序列化超 2KB 被拒绝', () => {
    const big = { blob: 'x'.repeat(CARD_DATA_MAX_BYTES) }
    expect(validateCardSubmitPayload({ summary: 'ok', data: big }).ok).toBe(false)
  })

  it('data 含函数 / 循环引用被拒绝；共享引用（DAG）允许', () => {
    expect(validateCardSubmitPayload({ summary: 'ok', data: { fn: () => 1 } }).ok).toBe(false)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(validateCardSubmitPayload({ summary: 'ok', data: circular }).ok).toBe(false)
    const shared = { v: 1 }
    expect(validateCardSubmitPayload({ summary: 'ok', data: { a: shared, b: shared } }).ok).toBe(true)
  })

  it('data 为数组 / 嵌套结构可用；NaN、类实例被拒绝', () => {
    expect(validateCardSubmitPayload({ summary: 'ok', data: [1, 'a', { b: null }] }).ok).toBe(true)
    expect(validateCardSubmitPayload({ summary: 'ok', data: { n: NaN } }).ok).toBe(false)
    expect(validateCardSubmitPayload({ summary: 'ok', data: new Date() }).ok).toBe(false)
  })
})

describe('deriveRepliedCardIds（已回复集合派生）', () => {
  it('从 html-card-reply 围栏提取 cardId', () => {
    const messages = [
      { content: '前言\n\n```html-card-reply card="msg-1:0"\n{"choice":"B"}\n```\n' },
      { content: '无围栏消息' },
      { content: '```html-card-reply card="msg-2:1"\n{}\n```' },
    ]
    expect([...deriveRepliedCardIds(messages)].sort()).toEqual(['msg-1:0', 'msg-2:1'])
  })

  it('无 card 属性 / 普通围栏不产生 cardId', () => {
    const messages = [
      { content: '```html-card-reply\n{}\n```' },
      { content: '```html-card title="x"\n<div/>\n```' },
    ]
    expect(deriveRepliedCardIds(messages).size).toBe(0)
  })

  it('buildCardReplyBody 构造的回执可被 derive 回读（往返一致）', () => {
    const body = buildCardReplyBody('选择了方案 B（沙箱 iframe），预算上限 3 天', 'uuid-1:0', { choice: 'B', budget_days: 3 })
    expect(body).toContain('选择了方案 B')
    expect(body).toContain('```html-card-reply card="uuid-1:0"')
    expect(body).toContain('{"choice":"B","budget_days":3}')
    expect(deriveRepliedCardIds([{ content: body }]).has('uuid-1:0')).toBe(true)
  })

  it('data 缺省时回执 JSON 为 {}', () => {
    const body = buildCardReplyBody('确认', 'm:0', undefined)
    expect(body).toContain('\n{}\n')
  })
})

describe('常量与工具', () => {
  it('预算常量符合设计文档（2 张 / 4KB / 500 字符 / 2KB）', () => {
    expect(CARD_MAX_PER_MESSAGE).toBe(2)
    expect(CARD_MAX_BYTES).toBe(4096)
    expect(CARD_SUMMARY_MAX_CHARS).toBe(500)
    expect(CARD_DATA_MAX_BYTES).toBe(2048)
  })

  it('byteLength 按 UTF-8 计（中文 3 字节）', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('獭')).toBe(3)
  })
})
