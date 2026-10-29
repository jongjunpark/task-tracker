export type TaskStatus = 'now' | 'blocked' | 'paused' | 'waiting' | 'done' | 'dropped'

export type Task = {
  id: number
  title: string
  status: TaskStatus
  doing?: string
  // 확인 필요(blocked)일 때 사람이 답하거나 해야 할 일, 한 문장
  ask?: string
  messageIds: number[]
  createdAt: number
  updatedAt: number
}

export type Message = {
  id: number
  text: string
  at: number
  isMidTurn: boolean
  taskId?: number
  isIgnored?: boolean
  // 체크리스트에 보이는 요청 요약. 없으면 원문을 줄여 쓴다.
  summary?: string
  isResolved?: boolean
}

export type Ledger = {
  tasks: Task[]
  messages: Message[]
  nextTaskId: number
  nextMessageId: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-tracker': { ledger: Shaped<Ledger>; expanded: number[]; collapsed: string[]; resolvedShown: number[] }
  }
}
