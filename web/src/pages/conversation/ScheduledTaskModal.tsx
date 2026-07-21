import { useState } from 'react'
import { Clock, Loader } from 'lucide-react'
import { Modal, ModalButton } from '../../components/Modal'
import type { LocalScheduledTask, LocalOtter } from '../../lib/mappers'

interface Props {
  mode: 'create' | 'edit'
  task?: LocalScheduledTask | null
  otters: LocalOtter[]
  onSave: (data: {
    name: string
    cron: string
    timezone: string
    body: string
    talkingStonePassedTo: string[]
  }) => void
  onClose: () => void
}

const CRON_PRESETS = [
  { label: '每天 09:00', value: '0 9 * * *' },
  { label: '每天 01:00', value: '0 1 * * *' },
  { label: '每 2 小时', value: '0 */2 * * *' },
  { label: '工作日 09:00', value: '0 9 * * 1-5' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
]

const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'UTC',
]

export function ScheduledTaskModal({ mode, task, otters, onSave, onClose }: Props) {
  const [name, setName] = useState(task?.name ?? '')
  const [cron, setCron] = useState(task?.cron ?? '0 9 * * *')
  const [timezone, setTimezone] = useState(task?.timezone ?? 'Asia/Shanghai')
  const [body, setBody] = useState(task?.body ?? '')
  const [selectedOtters, setSelectedOtters] = useState<string[]>(
    task?.talkingStonePassedTo ?? (otters.length === 1 ? [otters[0].id] : [])
  )
  const [saving, setSaving] = useState(false)

  // 表单验证
  const isValid = name.trim() && body.trim() && selectedOtters.length > 0 && cron.split(/\s+/).length === 5

  const handleToggleOtter = (otterId: string) => {
    setSelectedOtters(prev =>
      prev.includes(otterId)
        ? prev.filter(id => id !== otterId)
        : [...prev, otterId]
    )
  }

  const handleSave = async () => {
    if (!isValid || saving) return
    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        cron,
        timezone,
        body: body.trim(),
        talkingStonePassedTo: selectedOtters,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={mode === 'create' ? '新建定时任务' : '编辑定时任务'} onClose={onClose}>
      <div className="space-y-4 max-h-[60vh] overflow-y-auto px-1">
        {/* 任务名称 */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1.5">
            任务名称 <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例如：每日早安问候"
            className="form-input w-full"
            maxLength={100}
          />
        </div>

        {/* Cron 表达式 */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1.5">
            <Clock size={14} className="inline mr-1" />
            Cron 表达式 <span className="text-red-400">*</span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={cron}
              onChange={e => setCron(e.target.value)}
              placeholder="0 9 * * *"
              className="form-input flex-1 font-mono"
            />
            <select
              value={cron}
              onChange={e => setCron(e.target.value)}
              className="form-input w-auto"
            >
              {CRON_PRESETS.map(preset => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 时区 */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1.5">
            时区
          </label>
          <select
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            className="form-input w-full"
          >
            {TIMEZONES.map(tz => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>

        {/* 消息内容 */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1.5">
            触发消息 <span className="text-red-400">*</span>
          </label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="输入定时发送的消息内容..."
            className="form-input w-full"
            rows={3}
            maxLength={10000}
          />
          <div className="text-xs text-stone-400 mt-1 text-right">
            {body.length}/10000
          </div>
        </div>

        {/* 目标 Otter */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1.5">
            发言石传递给 <span className="text-red-400">*</span>
          </label>
          {otters.length === 0 ? (
            <div className="text-sm text-stone-400">暂无可用的 Otter</div>
          ) : (
            <div className="space-y-2">
              {otters.map(otter => (
                <label
                  key={otter.id}
                  className="flex items-center gap-2 p-2 rounded-lg hover:bg-stone-50 cursor-pointer transition"
                >
                  <input
                    type="checkbox"
                    checked={selectedOtters.includes(otter.id)}
                    onChange={() => handleToggleOtter(otter.id)}
                    className="rounded border-stone-300 text-otter-500 focus:ring-otter-500"
                  />
                  <div className="w-6 h-6 rounded-full bg-otter-100 flex items-center justify-center text-xs font-bold text-otter-600">
                    {otter.name.charAt(0)}
                  </div>
                  <span className="text-sm text-stone-700">{otter.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-stone-200">
        <ModalButton variant="secondary" onClick={onClose}>
          取消
        </ModalButton>
        <ModalButton
          variant="primary"
          onClick={handleSave}
          disabled={!isValid || saving}
        >
          {saving ? (
            <span className="flex items-center gap-1">
              <Loader size={12} className="animate-spin" />
              {mode === 'create' ? '创建中...' : '保存中...'}
            </span>
          ) : (
            mode === 'create' ? '创建' : '保存'
          )}
        </ModalButton>
      </div>
    </Modal>
  )
}
