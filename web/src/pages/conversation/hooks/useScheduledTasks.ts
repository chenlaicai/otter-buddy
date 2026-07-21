import { useState, useEffect, useCallback, useRef } from 'react'
import type { LocalScheduledTask } from '../../../lib/mappers'
import { mapScheduledTaskDTO } from '../../../lib/mappers'
import * as api from '../../../api/client'
import { showToast } from '../../../components/Toast'

export function useScheduledTasks(conversationId: string | null) {
  const [tasks, setTasks] = useState<LocalScheduledTask[]>([])
  const [loading, setLoading] = useState(false)

  // 使用 useRef 持有最新 tasks，避免 stale closure 问题
  const tasksRef = useRef(tasks)
  useEffect(() => { tasksRef.current = tasks }, [tasks])

  // 数据加载
  useEffect(() => {
    if (!conversationId) return
    setLoading(true)
    api.listScheduledTasks(conversationId)
      .then(res => setTasks(res.map(mapScheduledTaskDTO)))
      .finally(() => setLoading(false))
  }, [conversationId])

  // 轮询（每 30 秒）
  useEffect(() => {
    if (!conversationId) return
    const timer = setInterval(() => {
      api.listScheduledTasks(conversationId)
        .then(res => setTasks(res.map(mapScheduledTaskDTO)))
        .catch(() => {}) // 静默失败
    }, 30_000)
    return () => clearInterval(timer)
  }, [conversationId])

  // 乐观更新：启用/禁用
  const toggleStatus = useCallback(async (taskId: string) => {
    // 使用 ref 获取最新 tasks，避免 stale closure
    const task = tasksRef.current.find(t => t.id === taskId)
    if (!task) return
    const newStatus = task.status === 'active' ? 'disabled' : 'active'

    // 乐观更新
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t))

    try {
      await api.updateScheduledTask(taskId, { status: newStatus })
    } catch {
      // 回滚：从服务器重新获取最新状态
      showToast('操作失败', 'error')
      if (conversationId) {
        const fresh = await api.listScheduledTasks(conversationId)
        setTasks(fresh.map(mapScheduledTaskDTO))
      }
    }
  }, [conversationId])

  // 创建任务
  const create = useCallback(async (data: api.CreateScheduledTaskRequestDTO) => {
    if (!conversationId) return
    try {
      const task = await api.createScheduledTask(conversationId, data)
      setTasks(prev => [mapScheduledTaskDTO(task), ...prev])
      showToast('定时任务已创建', 'success')
      return task
    } catch (err) {
      showToast('创建失败', 'error')
      throw err
    }
  }, [conversationId])

  // 更新任务
  const update = useCallback(async (taskId: string, data: api.UpdateScheduledTaskRequestDTO) => {
    try {
      const task = await api.updateScheduledTask(taskId, data)
      setTasks(prev => prev.map(t => t.id === taskId ? mapScheduledTaskDTO(task) : t))
      showToast('定时任务已更新', 'success')
      return task
    } catch (err) {
      showToast('更新失败', 'error')
      throw err
    }
  }, [])

  // 删除任务
  const remove = useCallback(async (taskId: string) => {
    try {
      await api.deleteScheduledTask(taskId)
      setTasks(prev => prev.filter(t => t.id !== taskId))
      showToast('定时任务已删除', 'success')
    } catch (err) {
      showToast('删除失败', 'error')
      throw err
    }
  }, [])

  // 手动触发后立即刷新
  const trigger = useCallback(async (taskId: string) => {
    try {
      const result = await api.triggerScheduledTask(taskId)
      showToast('任务已触发', 'success')
      // 立即刷新，不等待轮询
      if (conversationId) {
        const fresh = await api.listScheduledTasks(conversationId)
        setTasks(fresh.map(mapScheduledTaskDTO))
      }
      return result
    } catch (err) {
      showToast('触发失败', 'error')
      throw err
    }
  }, [conversationId])

  return {
    tasks,
    loading,
    toggleStatus,
    create,
    update,
    remove,
    trigger,
  }
}
