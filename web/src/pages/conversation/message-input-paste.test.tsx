// @vitest-environment jsdom
/**
 * 多模态 Phase 2：输入框粘贴/拖拽附件测试。
 * 锁定行为：粘贴文件走上传管线（onPickFiles）；纯文本粘贴不打断（原生行为）；
 * 拖拽文件同管线；拖文本不拦截。
 *
 * 测试设施：jsdom 无 DataTransfer 构造器，用最小 stub（files/items/getData 三接口）
 * 构造 ClipboardEvent/DragEvent——不引 @testing-library/user-event（重依赖，两个事件够 stub）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MessageInput } from './MessageInput'
import type { StagedAttachment, UploadErrorInfo } from './hooks/useAttachmentStaging'

function pngFile(name = 'shot.png'): File {
  return new File([new ArrayBuffer(10)], name, { type: 'image/png' })
}

function renderInput(overrides?: Partial<Parameters<typeof MessageInput>[0]>) {
  const onPickFiles = vi.fn()
  const props = {
    onSend: vi.fn(),
    disabled: false,
    otters: [],
    conversationId: 'conv-1',
    staged: [] as StagedAttachment[],
    onRemoveAttachment: vi.fn(),
    onPickFiles,
    uploadError: null as UploadErrorInfo | null,
    onDismissUploadError: vi.fn(),
    ...overrides,
  }
  const utils = render(<MessageInput {...props} />)
  const textarea = utils.container.querySelector('textarea')!
  return { ...utils, textarea, onPickFiles, props }
}

/** jsdom DataTransfer stub：文件列表 + 文本读取 */
function makeDataTransfer(files: File[] = [], text = '') {
  return {
    files: files as unknown as FileList,
    types: files.length > 0 ? ['Files'] : (text ? ['text/plain'] : []),
    getData: (_type: string) => text,
  } as unknown as DataTransfer
}

function firePaste(el: Element, dt: DataTransfer) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: dt })
  el.dispatchEvent(ev)
  return ev
}

function fireDrop(el: Element, dt: DataTransfer) {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  el.dispatchEvent(ev)
  return ev
}

describe('MessageInput 粘贴/拖拽附件（多模态 Phase 2）', () => {
  it('粘贴图片文件：走上传管线（onPickFiles 收到 File[]）且阻止默认行为', () => {
    const { textarea, onPickFiles } = renderInput()

    const ev = firePaste(textarea, makeDataTransfer([pngFile()]))

    expect(onPickFiles).toHaveBeenCalledTimes(1)
    expect(onPickFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'shot.png', type: 'image/png' })])
    expect(ev.defaultPrevented).toBe(true)
  })

  it('粘贴纯文本：不打断（onPickFiles 不触发，默认行为保留）', () => {
    const { textarea, onPickFiles } = renderInput()

    const ev = firePaste(textarea, makeDataTransfer([], 'hello'))

    expect(onPickFiles).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('拖拽文件进输入框：走上传管线', () => {
    const { textarea, onPickFiles } = renderInput()

    const ev = fireDrop(textarea, makeDataTransfer([pngFile('drag.png')]))

    expect(onPickFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'drag.png' })])
    expect(ev.defaultPrevented).toBe(true)
  })

  it('拖拽纯文本（无 files）：不拦截', () => {
    const { textarea, onPickFiles } = renderInput()

    const ev = fireDrop(textarea, makeDataTransfer([], 'https://example.com'))

    expect(onPickFiles).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('粘贴多文件（图+文档混合）：全部走管线（校验由 pickValidFiles 统一做）', () => {
    const { textarea, onPickFiles } = renderInput()

    firePaste(textarea, makeDataTransfer([
      pngFile('a.png'),
      new File([new ArrayBuffer(5)], 'b.txt', { type: 'text/plain' }),
    ]))

    expect(onPickFiles).toHaveBeenCalledTimes(1)
    expect(onPickFiles.mock.calls[0][0]).toHaveLength(2)
  })

  it('粘贴非白名单文件也进管线（拒绝原因由 pickValidFiles 反馈，不在事件层预判）', () => {
    const { textarea, onPickFiles } = renderInput()

    firePaste(textarea, makeDataTransfer([new File([new ArrayBuffer(5)], 'v.zip', { type: 'application/zip' })]))

    expect(onPickFiles).toHaveBeenCalledTimes(1)
  })
})
