import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { Ledger, Message, Task, TaskStatus } from '../types'

type Progress = { done: number; total: number }

const PLUGIN = 'task-tracker'
const PANE = 'task-tracker'
const PANE_TITLE = '작업 목록'
const TOOL = 'tasks'
const TOOL_FULL = 'mcp__task-tracker__tasks'
const COMMAND = 'task-tracker'

const MAX_TASKS = 100
const MAX_MESSAGES = 300
const MAX_MESSAGE_CHARS = 2000

const EMPTY: Ledger = { tasks: [], messages: [], nextTaskId: 1, nextMessageId: 1 }

// 필드가 바뀌면 shape 태그를 올린다: 이전 버전이 저장한 값은 reload 뒤에도 남는다.
// ledger-1 의 Task.step 은 남아 있어도 읽지 않으므로 태그는 그대로 둔다.
const ledger = atom({ plugin: 'task-tracker', key: 'ledger' } as const, EMPTY, {
  shape: 'ledger-1',
})
const expanded = atom({ plugin: 'task-tracker', key: 'expanded' } as const, [])
// 접힌 상태 묶음: 상태 이름, 분류 전은 'unsorted'
const collapsed = atom({ plugin: 'task-tracker', key: 'collapsed' } as const, [])
// 처리된 요청을 펼쳐 둔 작업 id. 기본은 처리된 요청을 「처리됨 N개」 한 줄로 접는다
const resolvedShown = atom({ plugin: 'task-tracker', key: 'resolvedShown' } as const, [])

const STATUSES: readonly TaskStatus[] = ['now', 'blocked', 'paused', 'waiting', 'done', 'dropped']

const LABEL: Record<TaskStatus, string> = {
  now: '진행',
  blocked: '확인 필요',
  paused: '보류',
  waiting: '대기',
  done: '완료',
  dropped: '취소',
}

const COLOR: Record<TaskStatus, string> = {
  now: 'suggestion',
  blocked: 'warning',
  paused: 'claude',
  waiting: 'subtle',
  done: 'success',
  dropped: 'inactive',
}

// SVG 는 테마 키를 모르므로 상태 색을 hex 로 따로 둔다
const HEX: Record<TaskStatus, string> = {
  now: '#5B8DEF',
  blocked: '#D9A43B',
  paused: '#D97757',
  waiting: '#8E8E8E',
  done: '#4FA866',
  dropped: '#7A7A7A',
}

const BAR_WIDTH = 22
const BAND_BAR_WIDTH = 40
const BAR_HEIGHT = 6
const BAR_CELLS = 3
// 아이콘 그림은 그림 자체에 투명 여백을 둬서 ICON_WIDTH x ICON_HEIGHT 로 넓힌다(누를 자리 확보)
const ICON_WIDTH = 18
const ICON_HEIGHT = 20

// size x size 아이콘을 넓힌 그림의 한가운데에 둔다
const iconSvg = (size: number, body: string) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_WIDTH}" height="${ICON_HEIGHT}" viewBox="0 0 ${ICON_WIDTH} ${ICON_HEIGHT}">`,
    `<g transform="translate(${(ICON_WIDTH - size) / 2} ${(ICON_HEIGHT - size) / 2})">${body}</g>`,
    '</svg>',
  ].join('')

// 앱의 펼침 표시와 같은 모서리 둥근 작은 삼각형
const foldSvg = (path: string) => iconSvg(10, `<path d="${path}" fill="#8E8E8E"/>`)
// 그림으로 그리는 작은 회색 글자(작업 완료·취소). 한글은 글자 크기의 0.95배, 그 밖은 0.4배 폭으로 어림한다
const TEXT_BUTTON_FONT = 11
const TEXT_BUTTON_HEIGHT = 18
const TEXT_BUTTON_PAD = 2
const FILLER_PX = 7
// 데스크톱 버튼이 빈 글자 바깥에 스스로 붙이는 좌우 여백(어림값). 이만큼 빼고 빈 글자 수를 정해야 버튼이 글자보다 커지지 않는다
const BUTTON_SIDE_PX = 20

const textSvgWidth = (label: string) =>
  Math.ceil(
    [...label].reduce((sum, char) => sum + (/[\u3131-\uD7A3]/.test(char) ? TEXT_BUTTON_FONT * 0.95 : TEXT_BUTTON_FONT * 0.4), 0) +
      TEXT_BUTTON_PAD * 2,
  )

const textSvg = (label: string) => {
  const width = textSvgWidth(label)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TEXT_BUTTON_HEIGHT}" viewBox="0 0 ${width} ${TEXT_BUTTON_HEIGHT}">`,
    `<text x="${width / 2}" y="${TEXT_BUTTON_HEIGHT / 2}" text-anchor="middle" dominant-baseline="central"`,
    ` font-family="-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif" font-size="${TEXT_BUTTON_FONT}" fill="#8E8E8E">`,
    label,
    '</text></svg>',
  ].join('')
}

// 요청 체크박스(12x12): 처리됨은 초록 바탕에 흰 체크, 남음은 회색 테두리 빈 네모
const CHECKBOX_SIZE = 12
const CHECKBOX_DONE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">',
  `<rect x="0.5" y="0.5" width="11" height="11" rx="3" fill="${HEX.done}"/>`,
  '<path d="M3.2 6.2l1.8 1.8 3.8-3.9" fill="none" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')
const CHECKBOX_OPEN_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">',
  '<rect x="1" y="1" width="10" height="10" rx="2.5" fill="none" stroke="#8E8E8E" stroke-width="1.2"/>',
  '</svg>',
].join('')

// 세로 간격용 투명 그림과 간격 값(px)
// 내용 없는 빈 그림은 그려지지 않을 수 있어서 투명한 사각형을 하나 넣는다
const spacerSvg = (px: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${px}" viewBox="0 0 1 ${px}"><rect width="1" height="${px}" fill="#000000" fill-opacity="0"/></svg>`
const ROW_GAP_PX = 2
const TITLE_GAP_PX = 4

const FOLD_DOWN_SVG = foldSvg('M1.5 3.2 Q1 2.5 1.8 2.5 H8.2 Q9 2.5 8.5 3.2 L5.6 7.3 Q5 8 4.4 7.3 Z')
const FOLD_RIGHT_SVG = foldSvg('M3.2 1.5 Q2.5 1 2.5 1.8 V8.2 Q2.5 9 3.2 8.5 L7.3 5.6 Q8 5 7.3 4.4 Z')

// 요청 목록 안의 「처리됨 N개」 접기 삼각형: 체크박스와 같은 폭(12)이라 체크박스 열에 맞춰 선다
const ROW_FOLD_WIDTH = CHECKBOX_SIZE
const ROW_FOLD_HEIGHT = 14
const rowFoldSvg = (path: string) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ROW_FOLD_WIDTH}" height="${ROW_FOLD_HEIGHT}" viewBox="0 0 ${ROW_FOLD_WIDTH} ${ROW_FOLD_HEIGHT}">`,
    `<g transform="translate(1 2)"><path d="${path}" fill="#8E8E8E"/></g>`,
    '</svg>',
  ].join('')
const ROW_FOLD_DOWN_SVG = rowFoldSvg('M1.5 3.2 Q1 2.5 1.8 2.5 H8.2 Q9 2.5 8.5 3.2 L5.6 7.3 Q5 8 4.4 7.3 Z')
const ROW_FOLD_RIGHT_SVG = rowFoldSvg('M3.2 1.5 Q2.5 1 2.5 1.8 V8.2 Q2.5 9 3.2 8.5 L7.3 5.6 Q8 5 7.3 4.4 Z')

// 선 휴지통(비우기)
const TRASH_SVG = iconSvg(
  14,
  [
    '<g fill="none" stroke="#8E8E8E" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M2.5 3.8h9"/><path d="M5.5 3.8V2.6h3v1.2"/>',
    '<path d="M3.6 3.8l.6 7.6c.05.6.5 1 1.1 1h3.4c.6 0 1.05-.4 1.1-1l.6-7.6"/>',
    '<path d="M5.8 6.2v3.8M8.2 6.2v3.8"/>',
    '</g>',
  ].join(''),
)

const isOpen = (task: Task) => task.status !== 'done' && task.status !== 'dropped'

const isUnsorted = (message: Message) => message.taskId === undefined && message.isIgnored !== true

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// 다른 세션이 넘긴 요청(오케스트레이션). 사람 눈에 안 보이는 메시지(isMeta)로 오지만 기록한다
const SESSION_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set(['peer', 'peer-send-message', 'coordinator', 'projects-relay'])

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' }

// 「Another Claude session sent a message」 머리글과 뒤에 붙는 안내를 떼고 본문만 남긴다. encoded="1" 이면 본문이 HTML 이스케이프돼 있다
const peerBody = (text: string) => {
  const found = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(text)

  if (found === null) {
    return text
  }

  const [, attrs = '', body = ''] = found

  return /\bencoded="1"/.test(attrs) ? body.replace(/&(?:lt|gt|quot|#39|amp);/g, one => ENTITIES[one] ?? one) : body
}

const ratio = (progress: Progress) => (progress.total > 0 ? progress.done / progress.total : 0)

// 둥근 트랙 위에 상태 색으로 채운 진행 막대 (Svg 를 그리는 surface 용)
const barSvg = (progress: Progress, color: string, width = BAR_WIDTH) => {
  const filled = Math.round(ratio(progress) * width)
  const radius = BAR_HEIGHT / 2
  const fill =
    filled > 0
      ? `<rect width="${Math.max(filled, BAR_HEIGHT)}" height="${BAR_HEIGHT}" rx="${radius}" fill="${color}"/>`
      : ''

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_HEIGHT}" viewBox="0 0 ${width} ${BAR_HEIGHT}">`,
    `<rect width="${width}" height="${BAR_HEIGHT}" rx="${radius}" fill="#8E8E8E" fill-opacity="0.25"/>`,
    fill,
    '</svg>',
  ].join('')
}

// 터미널용: 같은 선을 채운 칸만 상태 색으로 칠한다
const barCells = (progress: Progress) => {
  const filled = Math.round(ratio(progress) * BAR_CELLS)

  return { filled: '━'.repeat(filled), rest: '━'.repeat(BAR_CELLS - filled) }
}

const messagesOf = (state: Ledger, task: Task) =>
  task.messageIds.flatMap(id => state.messages.filter(message => message.id === id))

// 완료된 작업은 남은 요청이 있어도 전부 처리된 것으로 본다
const isResolvedIn = (task: Task, message: Message) => task.status === 'done' || message.isResolved === true

// 진행도 = 작업에 붙은 요청 중 처리된 수. 요청이 없는 작업은 진행도가 없다.
const progressOf = (state: Ledger, task: Task): Progress | undefined => {
  const messages = messagesOf(state, task)

  return messages.length === 0
    ? undefined
    : { done: messages.filter(message => isResolvedIn(task, message)).length, total: messages.length }
}

const progressText = (progress: Progress) => `${progress.done}/${progress.total}`

const requestText = (message: Message) => message.summary ?? clip(oneLine(message.text), 80)

const byStatus = (tasks: readonly Task[]) =>
  STATUSES.map(status => ({ status, tasks: tasks.filter(task => task.status === status) })).filter(
    group => group.tasks.length > 0,
  )

const countText = (state: Ledger) => {
  const parts = byStatus(state.tasks)
    .filter(group => group.status !== 'dropped')
    .map(group => `${LABEL[group.status]} ${group.tasks.length}`)
  const unsorted = state.messages.filter(isUnsorted).length

  return [...parts, ...(unsorted > 0 ? [`분류 전 ${unsorted}`] : [])].join(' · ')
}

// 모델에게 보내는 목록에 자세히 싣는 최근 완료 작업 수, 그보다 오래된 완료 작업을 제목만 싣는 최대 수와 제목 길이
const RECENT_DONE = 3
const OLDER_DONE_MAX = 10
const OLDER_TITLE_CHARS = 14

const taskLine = (state: Ledger, task: Task) => {
  const progress = progressOf(state, task)
  const pending = messagesOf(state, task)
    .filter(message => !isResolvedIn(task, message))
    .map(message => `m${message.id}`)
  const detail = progress
    ? ` (${progressText(progress)}${pending.length > 0 ? `; open: ${pending.join(', ')}` : ''})`
    : ''
  const doing = task.doing ? ` — ${task.doing}` : ''
  const ask = task.status === 'blocked' && task.ask ? ` — needs from person: ${task.ask}` : ''

  return `#${task.id} [${LABEL[task.status]}] ${task.title}${detail}${doing}${ask}`
}

// 모델에게 보내는 목록: 메시지마다 붙으므로 길이가 쌓이지 않게 한다.
// 안 끝난 작업은 전부 자세히, 완료는 최근 RECENT_DONE 개만 자세히, 그보다 오래된 완료는 번호와 짧은 제목만 한 줄로 싣는다
// (예전 작업에 대한 후속 요청도 attach 할 수 있게). 취소된 작업은 싣지 않는다.
// 처리 안 된 요청의 mN 을 같이 알려 resolve 할 수 있게 한다
const listText = (state: Ledger) => {
  const open = state.tasks.filter(isOpen)
  const done = state.tasks
    .filter(task => task.status === 'done')
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const recent = done.slice(0, RECENT_DONE)
  const older = done.slice(RECENT_DONE)
  const olderShown = older.slice(0, OLDER_DONE_MAX).map(task => `#${task.id} ${clip(task.title, OLDER_TITLE_CHARS)}`)
  const olderRest = older.length - olderShown.length
  const lines = [...open, ...recent].map(task => taskLine(state, task))
  const unsorted = state.messages.filter(isUnsorted).map(message => `m${message.id}`)

  return [
    ...(lines.length > 0 ? lines : ['(no tasks yet)']),
    ...(olderShown.length > 0
      ? [`Done earlier: ${olderShown.join(', ')}${olderRest > 0 ? ` (+${olderRest} more)` : ''}`]
      : []),
    ...(unsorted.length > 0 ? [`Unclassified messages: ${unsorted.join(', ')}`] : []),
  ].join('\n')
}

// 한 번에 진행 중인 작업은 하나: 다른 작업을 now 로 올리면 기존 now 는 보류로 내린다.
const setNow = (tasks: readonly Task[], id: number, at: number) =>
  tasks.map(task =>
    task.id !== id && task.status === 'now' ? { ...task, status: 'paused' as const, updatedAt: at } : task,
  )

// 상한을 넘으면 끝난(완료·취소) 작업부터 오래된 순으로 버리고, 그래도 넘칠 때만 남은 작업 중 오래된 것을 버린다
const capTasks = (tasks: readonly Task[]): Task[] => {
  const overflow = tasks.length - MAX_TASKS

  if (overflow <= 0) {
    return [...tasks]
  }

  const finished = tasks.filter(task => !isOpen(task)).slice(0, overflow).map(task => task.id)
  const kept = tasks.filter(task => !finished.includes(task.id))

  return kept.slice(-MAX_TASKS)
}

type Op = {
  op: string
  title?: unknown
  message?: unknown
  task?: unknown
  status?: unknown
  doing?: unknown
  summary?: unknown
  ask?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toOps = (value: unknown): Op[] =>
  Array.isArray(value)
    ? value.filter(isRecord).flatMap(one => (typeof one.op === 'string' ? [{ ...one, op: one.op }] : []))
    : []

const asId = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : undefined)

const asStatus = (value: unknown) => STATUSES.find(status => status === value)

const asText = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() !== '' ? clip(oneLine(value), max) : undefined

type Applied = { state: Ledger; notes: string[] }

const changeMessage = (state: Ledger, messageId: number, change: (message: Message) => Message): Ledger => ({
  ...state,
  messages: state.messages.map(message => (message.id === messageId ? change(message) : message)),
})

const linkMessage = (state: Ledger, messageId: number | undefined, taskId: number, summary?: string): Ledger =>
  messageId === undefined
    ? state
    : changeMessage(state, messageId, message => ({
        ...message,
        taskId,
        isIgnored: undefined,
        summary: summary ?? message.summary,
      }))

// 확인 필요(blocked)는 사람이 할 일(ask)이 있어야만 걸 수 있다
const BLOCKED_NEEDS_ASK = 'blocked needs `ask`: one sentence of what the person must answer or do'

const applyOp = ({ state, notes }: Applied, op: Op, at: number): Applied => {
  const messageId = asId(op.message)
  const taskId = asId(op.task)
  const summary = asText(op.summary, 60)
  const ask = asText(op.ask, 120)
  const hasMessage = messageId === undefined || state.messages.some(message => message.id === messageId)
  const target = state.tasks.find(task => task.id === taskId)

  if (!hasMessage) {
    return { state, notes: [...notes, `${op.op}: no message m${messageId}`] }
  }

  if (op.op === 'add') {
    const title = asText(op.title, 80)

    if (title === undefined) {
      return { state, notes: [...notes, 'add: title is required'] }
    }

    const id = state.nextTaskId
    const wanted = asStatus(op.status) ?? 'waiting'
    const isAskMissing = wanted === 'blocked' && ask === undefined
    const status = isAskMissing ? 'waiting' : wanted
    const task: Task = {
      id,
      title,
      status,
      doing: asText(op.doing, 80),
      ask: status === 'blocked' ? ask : undefined,
      messageIds: messageId === undefined ? [] : [messageId],
      createdAt: at,
      updatedAt: at,
    }
    const tasks = [...(status === 'now' ? setNow(state.tasks, id, at) : state.tasks), task]
    const next = { ...state, tasks: capTasks(tasks), nextTaskId: id + 1 }

    return {
      state: linkMessage(next, messageId, id, summary),
      notes: [...notes, isAskMissing ? `added #${id} as waiting (${BLOCKED_NEEDS_ASK})` : `added #${id}`],
    }
  }

  if (op.op === 'ignore' || op.op === 'resolve') {
    if (messageId === undefined) {
      return { state, notes: [...notes, `${op.op}: message is required`] }
    }

    const changed =
      op.op === 'ignore'
        ? changeMessage(state, messageId, message => ({ ...message, isIgnored: true, taskId: undefined }))
        : changeMessage(state, messageId, message => ({ ...message, isResolved: true }))

    return { state: changed, notes: [...notes, `${op.op}d m${messageId}`] }
  }

  if (target === undefined) {
    return { state, notes: [...notes, `${op.op}: no task #${taskId}`] }
  }

  if (op.op === 'attach') {
    if (messageId === undefined) {
      return { state, notes: [...notes, 'attach: message is required'] }
    }

    // 확인 필요 작업에 새 메시지가 붙으면 답이 온 것으로 보고 진행으로 돌린다
    const isUnblocking = target.status === 'blocked'
    const base = isUnblocking ? setNow(state.tasks, target.id, at) : state.tasks
    const tasks = base.map(task =>
      task.id === target.id
        ? {
            ...task,
            messageIds: task.messageIds.includes(messageId) ? task.messageIds : [...task.messageIds, messageId],
            status: isUnblocking ? ('now' as const) : task.status,
            ask: isUnblocking ? undefined : task.ask,
            updatedAt: at,
          }
        : task,
    )

    return {
      state: linkMessage({ ...state, tasks }, messageId, target.id, summary),
      notes: [...notes, `attached m${messageId} to #${target.id}${isUnblocking ? ' (unblocked, now)' : ''}`],
    }
  }

  if (op.op === 'update') {
    const status = asStatus(op.status) ?? target.status
    const nextAsk = status === 'blocked' ? (ask ?? target.ask) : undefined

    if (status === 'blocked' && nextAsk === undefined) {
      return { state, notes: [...notes, `update #${target.id}: ${BLOCKED_NEEDS_ASK}`] }
    }

    const isFinished = status === 'done' || status === 'dropped'
    const changed: Task = {
      ...target,
      title: asText(op.title, 80) ?? target.title,
      status,
      doing: isFinished ? undefined : (asText(op.doing, 80) ?? target.doing),
      ask: nextAsk,
      updatedAt: at,
    }
    const base = status === 'now' ? setNow(state.tasks, target.id, at) : state.tasks
    const tasks = base.map(task => (task.id === target.id ? changed : task))

    return { state: { ...state, tasks }, notes: [...notes, `updated #${target.id}`] }
  }

  return { state, notes: [...notes, `unknown op "${op.op}"`] }
}

const TOOL_DESCRIPTION = [
  "Keeps the person's task list for this session, shown to them in a pane beside the chat.",
  'Every message the person sends is logged as mN and you are told its id.',
  'Classify each one: `add` a task when it asks for new work (title: a short noun phrase in the',
  "person's language), `attach` it to an existing task when it adds to, corrects, questions or follows",
  'up on that task, `ignore` it only when it neither asks for work nor touches a task.',
  'With `add` and `attach`, give `summary`: what that message asks for, a few words in their language.',
  "A task's progress is its messages handled out of its messages: `resolve` a message once you have",
  'done what it asked or answered it, in the same call as other updates when you can.',
  'Keep statuses true as you work: `update` a task to `now` when you start it (only one task is `now`;',
  'the previous one becomes `paused` on its own), `done` when the work is finished and you have checked',
  'it (tests, type check), even if the person has not looked at it yet; `dropped` when the person cancels',
  'it. Use `blocked` only when you cannot go on without the person: a choice only they can make, or an',
  'action only they can take (a reload, a login). Never use it to wait for them to look at finished work.',
  'But if you end your turn asking them to decide the next step on a task (whether to go ahead with a fix,',
  'which option to take), that task is not `done`: set it `blocked` with that question as `ask`, and set',
  '`done` only once their answer leaves nothing on it to do.',
  '`blocked` requires `ask`: one concrete sentence, addressed to them, of what they must answer or do',
  '(e.g. "Pick icon 1, 2 or 3", "Run /reload-plugins"). Attaching their next message to a blocked task',
  'moves it back to `now` on its own. Give a few words in `doing` for the task in progress.',
  'Do not mention these updates in your reply.',
].join(' ')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'attach', 'resolve', 'ignore', 'update'] },
          message: { type: 'integer', description: 'Message id N of mN' },
          task: { type: 'integer', description: 'Task id N of #N' },
          title: { type: 'string' },
          summary: { type: 'string', description: 'What the message asks for, a few words' },
          status: { type: 'string', enum: [...STATUSES] },
          doing: { type: 'string', description: 'What is being done now, a few words' },
          ask: { type: 'string', description: 'With status blocked: what the person must answer or do, one sentence' },
        },
        required: ['op'],
      },
    },
  },
  required: ['ops'],
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: PANE_TITLE })

const toggle = ($: EngineInterface, id: number) =>
  update($, expanded, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))

const toggleResolved = ($: EngineInterface, id: number) =>
  update($, resolvedShown, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))

const toggleFold = ($: EngineInterface, group: string) =>
  update($, collapsed, groups => (groups.includes(group) ? groups.filter(one => one !== group) : [...groups, group]))

// 끝난 묶음(완료·취소)만 비울 수 있다
const isClearable = (status: TaskStatus) => status === 'done' || status === 'dropped'

const clearGroup = ($: EngineInterface, status: TaskStatus) =>
  update($, ledger, state => ({ ...state, tasks: state.tasks.filter(task => task.status !== status) }))

// 끝난 작업 하나만 목록에서 지운다
const deleteTask = ($: EngineInterface, id: number) =>
  update($, ledger, state => ({ ...state, tasks: state.tasks.filter(task => task.id !== id) }))

const setStatus = async ($: EngineInterface, id: number, status: TaskStatus) => {
  const at = await $.clock.now()
  await update($, ledger, state => applyOp({ state, notes: [] }, { op: 'update', task: id, status }, at).state)
}

const runCommand = async ($: EngineInterface, args: string) => {
  const [verb = '', rawId = ''] = args.trim().split(/\s+/)
  const id = Number.parseInt(rawId.replace(/^#/, ''), 10)

  if (verb === '') {
    await openPane($)
    const state = await read($, ledger)

    return state.tasks.length === 0 ? '아직 기록된 작업이 없습니다.' : `작업 목록을 열었습니다. ${countText(state)}`
  }

  if ((verb === 'done' || verb === 'drop') && Number.isInteger(id)) {
    await setStatus($, id, verb === 'done' ? 'done' : 'dropped')

    return `#${id} 을(를) ${verb === 'done' ? '완료' : '취소'}로 바꿨습니다.`
  }

  if (verb === 'clear') {
    await update($, ledger, state => ({ ...state, tasks: state.tasks.filter(isOpen) }))

    return '완료·취소된 작업을 목록에서 뺐습니다.'
  }

  if (verb === 'reset') {
    await update($, ledger, () => EMPTY)

    return '작업 목록을 비웠습니다.'
  }

  return '사용법: /task-tracker · /task-tracker done <번호> · /task-tracker drop <번호> · /task-tracker clear · /task-tracker reset'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description: '이 세션에서 시킨 작업 목록 열기',
      argumentHint: '[done|drop <번호> | clear | reset]',
      immediate: true,
    })

    return next(e)
  })

  // 메시지 기록은 모델에 맡기지 않는다: 보낸 메시지는 훅이 바로 적고, 모델은 분류만 한다.
  on('prompt.submit', async ($, e, next) => {
    const isFromSession = SESSION_ORIGINS.has(e.origin.kind)
    const text = (isFromSession ? peerBody(e.text) : e.text).trim()

    if (e.command !== undefined || (e.isMeta === true && !isFromSession) || text === '') {
      return next(e)
    }

    const at = await $.clock.now()
    let logged: { id: number; state: Ledger } | undefined

    await update($, ledger, state => {
      const message: Message = {
        id: state.nextMessageId,
        text: clip(text, MAX_MESSAGE_CHARS),
        at,
        isMidTurn: e.turnId !== undefined,
      }
      const changed = {
        ...state,
        messages: [...state.messages, message].slice(-MAX_MESSAGES),
        nextMessageId: message.id + 1,
      }
      logged = { id: message.id, state: changed }

      return changed
    })

    if (logged === undefined) {
      return next(e)
    }

    const note = [
      `[${PLUGIN}] This message is logged as m${logged.id}.`,
      `Classify it with the ${TOOL_FULL} tool (add / attach / ignore), resolve messages you have handled,`,
      'and keep task statuses current.',
      'Tasks now:',
      listText(logged.state),
    ].join('\n')

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const ops = toOps('ops' in e ? e.ops : undefined)

    if (ops.length === 0) {
      return { result: 'No ops given. Pass { ops: [{ op, ... }] }.' }
    }

    const at = await $.clock.now()
    let applied: Applied = { state: EMPTY, notes: [] }
    let wasEmpty = false

    await update($, ledger, state => {
      wasEmpty = state.tasks.length === 0
      applied = ops.reduce((acc, op) => applyOp(acc, op, at), { state, notes: [] as string[] })

      return applied.state
    })

    if (wasEmpty && applied.state.tasks.length > 0) {
      void openPane($)
    }

    return { result: `${applied.notes.join('; ')}\n${listText(applied.state)}` }
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // 터미널 표에도 Svg 키가 있지만 아무것도 그리지 않는다: 그림 요소는 터미널이 아닐 때만 쓰고, 터미널은 글자로 대신한다
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const state = await read($, ledger)
    const open = await read($, expanded)
    const folded = await read($, collapsed)
    const resolvedOpen = await read($, resolvedShown)
    const unsorted = state.messages.filter(isUnsorted)

    if (state.tasks.length === 0 && unsorted.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>아직 기록된 작업이 없습니다.</Text>
          <Text dimColor>메시지를 보내면 여기에 쌓입니다.</Text>
        </Box>
      )
    }

    const bar = (task: Task, progress: Progress) => {
      if (Svg) {
        return (
          <Svg
            source={barSvg(progress, HEX[task.status])}
            alt={`요청 ${progress.total}개 중 ${progress.done}개 처리`}
            width={BAR_WIDTH}
            height={BAR_HEIGHT}
          />
        )
      }

      const cells = barCells(progress)

      return (
        <Box flexDirection="row">
          <Text color={COLOR[task.status]}>{cells.filled}</Text>
          <Text dimColor>{cells.rest}</Text>
        </Box>
      )
    }

    // 상태 제목은 상태 색 글자로 두고, 앱의 펼침 표시처럼 제목 바로 뒤에 회색 삼각형(펼침 아래, 접힘 오른쪽)을 둔다.
    // Button 안에는 그림을 넣을 수 없어서, Svg 로 그린 삼각형 위에 빈 글자 Button 을 absolute 로 겹쳐 누를 수 있게 한다.
    // Svg 가 없는 터미널은 삼각형 글자 Button 으로 대신한다(U+FE0E 는 이모지로 바뀌지 않게 글자 모양으로 고정).
    // 계층은 들여쓰기로 만든다: 상태 제목 > 작업 제목(버튼 여백) · 지금 하는 일·요청(1칸).
    // 완료·취소 묶음은 줄 오른쪽에 그 묶음만 비우는 버튼을 둔다.
    // 그림 아이콘 버튼: 투명 여백으로 넓힌 그림 위에 같은 크기의 absolute 상자를 겹치고 그 가운데에 버튼을 둔다.
    // 버튼은 줄어들지 않는 상자(flexShrink 0)로 감싸야 상자에 눌려 폭이 줄지 않는다.
    // 버튼 폭은 안의 빈 글자 폭으로 정해진다. 일반 공백은 앞뒤가 잘려 폭이 생기지 않으므로,
    // 잘리지 않는 빈 글자(U+2800 점자 빈칸) 하나만 둔다.
    const iconButton = (
      key: string,
      source: string,
      alt: string,
      onPress: () => void,
      size: { width: number; height: number; fillers: number } = { width: ICON_WIDTH, height: ICON_HEIGHT, fillers: 1 },
    ) =>
      Svg && (
        <Box position="relative">
          <Svg source={source} alt={alt} width={size.width} height={size.height} />
          <Box position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" justifyContent="center">
            <Box flexShrink={0}>
              <Button key={key} plain onPress={onPress}>
                {'\u2800'.repeat(size.fillers)}
              </Button>
            </Box>
          </Box>
        </Box>
      )

    // 글자 버튼: 데스크톱 버튼은 안 글자 크기를 무시하므로, 작은 회색 글자를 그림으로 그리고 같은 방식으로 겹친다.
    // 누를 자리는 그림 폭에 맞춰 빈 글자 수로 넓힌다. 그림이 없는 터미널은 일반 글자 버튼.
    const textButton = (key: string, label: string, onPress: () => void) => {
      const width = textSvgWidth(label)

      return (
        iconButton(key, textSvg(label), label, onPress, {
          width,
          height: TEXT_BUTTON_HEIGHT,
          fillers: Math.max(1, Math.round((width - BUTTON_SIDE_PX) / FILLER_PX)),
        }) || (
          <Button key={key} plain dimColor onPress={onPress}>
            {label}
          </Button>
        )
      )
    }

    const foldToggle = (group: string, isFolded: boolean) =>
      iconButton(`group-${group}`, isFolded ? FOLD_RIGHT_SVG : FOLD_DOWN_SVG, isFolded ? '펼치기' : '접기', () =>
        toggleFold($, group),
      ) || (
        <Button key={`group-${group}`} plain dimColor onPress={() => toggleFold($, group)}>
          {isFolded ? '\u25B6\uFE0E' : '\u25BC\uFE0E'}
        </Button>
      )

    // 「처리됨 N개」 줄: 체크박스 열의 삼각형과 회색 글자 둘 다 눌러서 처리된 요청을 접고 편다.
    // 터미널은 삼각형 글자 버튼과 글자 버튼으로 대신한다
    const resolvedToggle = (task: Task, count: number, isFolded: boolean) => {
      const onPress = () => toggleResolved($, task.id)

      return (
        <Box flexDirection="row" alignItems="center" gap={Svg ? 'xs' : 1}>
          {iconButton(`resolved-icon-${task.id}`, isFolded ? ROW_FOLD_RIGHT_SVG : ROW_FOLD_DOWN_SVG, isFolded ? '펼치기' : '접기', onPress, {
            width: ROW_FOLD_WIDTH,
            height: ROW_FOLD_HEIGHT,
            fillers: 1,
          }) || (
            <Button key={`resolved-icon-${task.id}`} plain dimColor onPress={onPress}>
              {isFolded ? '\u25B6\uFE0E' : '\u25BC\uFE0E'}
            </Button>
          )}
          {textButton(`resolved-${task.id}`, `처리됨 ${count}개`, onPress)}
        </Box>
      )
    }

    // 묶음 전체 삭제는 글자 버튼 「모두 삭제」, 작업 하나 삭제는 작업 줄 끝의 휴지통
    const clearButton = (group: string, onClear: () => void) => textButton(`clear-${group}`, '모두 삭제', onClear)

    const deleteButton = (task: Task) =>
      iconButton(`delete-${task.id}`, TRASH_SVG, '삭제', () => deleteTask($, task.id)) || (
        <Button key={`delete-${task.id}`} plain dimColor onPress={() => deleteTask($, task.id)}>
          삭제
        </Button>
      )

    const heading = (group: string, label: string, count: number, color: string, onClear?: () => void) => {
      const isFolded = folded.includes(group)

      return (
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {/* 상태 이름과 개수는 한 글자 덩어리로 붙여 같은 상태 색으로 쓴다 */}
            <Text weight="semibold" color={color}>{`${label} ${count}`}</Text>
            {foldToggle(group, isFolded)}
          </Box>
          {onClear && clearButton(group, onClear)}
        </Box>
      )
    }

    // 진행 중인 작업은 체크리스트를 펼친 채로 두고, 누르면 접는다. 나머지는 반대.
    const isShown = (task: Task) => (task.status === 'now') !== open.includes(task.id)

    // 작업 아래 줄(지금 하는 일·요청)의 들여쓰기. 데스크톱 작업 제목은 버튼 앞 여백만큼 들어가 있어서,
    // 한 칸(1)보다 작은 데스크톱 간격 단계 sm 으로 제목 시작선에 가깝게 맞춘다. 터미널은 버튼 여백이 없어 1칸.
    const childInset = e.surface === 'terminal' ? 1 : 'sm'
    // 요청 목록(처리됨 줄·체크박스)은 제목과 같은 선에 서면 제목에 딸린 줄로 안 보여서 데스크톱에서는 한 단계 더 깊게 들인다
    const listInset = e.surface === 'terminal' ? childInset : 'lg'

    // 요청 표시: 처리됨은 초록 네모 체크, 남음은 빈 네모 (그림). 그림이 없는 터미널은 글자 ✓ / ☐
    const checkbox = (isDone: boolean) =>
      Svg ? (
        <Svg source={isDone ? CHECKBOX_DONE_SVG : CHECKBOX_OPEN_SVG} alt={isDone ? '처리됨' : '남음'} width={CHECKBOX_SIZE} height={CHECKBOX_SIZE} />
      ) : (
        <Text size="footnote" color={isDone ? 'success' : 'subtle'}>
          {isDone ? '✓' : '☐'}
        </Text>
      )

    // px 단위 세로 간격: 높이만 있는 투명 그림. Box 간격은 단계(xs·sm…)로만 정해져서 더 잘게 맞출 때 쓴다
    const spacer = (px: number) => Svg && <Svg source={spacerSvg(px)} alt="간격" width={1} height={px} />

    return (
      <Box flexDirection="column" gap={1}>
        {unsorted.length > 0 && (
          <Box flexDirection="column">
            {heading('unsorted', '분류 전', unsorted.length, 'warning')}
            {!folded.includes('unsorted') &&
              unsorted.map(message => (
                <Box paddingLeft={1}>
                  <Text color="subtle" wrap="truncate-end">
                    {oneLine(message.text)}
                  </Text>
                </Box>
              ))}
          </Box>
        )}
        {byStatus(state.tasks).map(group => (
          <Box flexDirection="column">
            {heading(
              group.status,
              LABEL[group.status],
              group.tasks.length,
              COLOR[group.status],
              isClearable(group.status) ? () => clearGroup($, group.status) : undefined,
            )}
            {!folded.includes(group.status) &&
              group.tasks.map(task => {
                const progress = progressOf(state, task)
                const isFaded = !isOpen(task)
                const hasActions = isOpen(task) && isShown(task)
                // 처리된 요청과 남은 요청이 섞여 있을 때만 처리된 요청을 맨 위 「처리됨 N개」 한 줄로 접는다.
                // 펼치면 원래 순서대로 전부 보인다. 전부 처리된 작업은 접으면 남는 게 없으므로 그대로 다 보인다
                const messages = messagesOf(state, task)
                const resolvedCount = messages.filter(message => isResolvedIn(task, message)).length
                const canFold = resolvedCount > 0 && resolvedCount < messages.length
                const isResolvedFolded = canFold && !resolvedOpen.includes(task.id)
                const shownMessages = isResolvedFolded ? messages.filter(message => !isResolvedIn(task, message)) : messages

                // 한 작업 = 제목 줄 하나(오른쪽에 진행 막대) + 필요할 때만 보조 줄.
                // 요청 목록이 펼쳐진 작업은 다음 작업과 붙어 보이지 않게 아래에 간격을 둔다.
                return (
                  <Box flexDirection="column" marginBottom={isShown(task) ? 'sm' : 0}>
                    {/* 번호(#N)는 버튼 밖이라 여백이 없다. 좁아져도 번호와 진행 숫자가 붙어 「#10/1」 처럼 읽히지 않게 간격을 둔다 */}
                    <Box flexDirection="row" alignItems="center" gap={e.surface === 'terminal' ? 1 : 'sm'}>
                      {/* 제목을 누르면 요청 목록이 접히고 펼쳐진다.
                          제목이 줄어들고 막대는 줄어들지 않게 해서 막대가 잘리지 않게 한다 */}
                      {/* 데스크톱은 버튼 안 글자 색을 무시해서, 회색으로 그릴 번호(#N)는 버튼 밖에 둔다.
                          데스크톱은 버튼의 오른쪽 여백이 제목과 번호 사이를 띄운다 */}
                      <Box
                        flexDirection="row"
                        alignItems="center"
                        gap={e.surface === 'terminal' ? 1 : 0}
                        flexGrow={1}
                        flexShrink={1}
                        minWidth={0}
                      >
                        <Box flexShrink={1} minWidth={0} overflow="hidden">
                          <Button key={`task-${task.id}`} plain onPress={() => toggle($, task.id)}>
                            <Text
                              weight="semibold"
                              color={isFaded ? 'subtle' : undefined}
                              strikethrough={task.status === 'dropped'}
                            >
                              {task.title}
                            </Text>
                          </Button>
                        </Box>
                        <Box flexShrink={0}>
                          <Text size="footnote" dimColor>{`#${task.id}`}</Text>
                        </Box>
                      </Box>
                      {/* 막대와 휴지통 사이도 숫자와 막대 사이와 같은 간격 */}
                      {(progress || isClearable(task.status)) && (
                        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
                          {progress && (
                            <Text size="footnote" dimColor tabular>
                              {progressText(progress)}
                            </Text>
                          )}
                          {progress && bar(task, progress)}
                          {isClearable(task.status) && <Box flexShrink={0}>{deleteButton(task)}</Box>}
                        </Box>
                      )}
                    </Box>
                    {/* 확인 필요 작업은 접혀 있어도 사람이 할 일을 제목 바로 아래 상태 색 작은 글씨로, 딸린 항목임을 뜻하는 ⤷ 와 함께 보여 준다 */}
                    {task.status === 'blocked' && task.ask && (
                      <Box paddingLeft={childInset}>
                        <Text size="caption" color={COLOR.blocked} wrap="wrap">
                          {`⤷ ${task.ask}`}
                        </Text>
                      </Box>
                    )}
                    {isShown(task) && (
                      <Box flexDirection="column" paddingLeft={listInset}>
                        {/* 간격 단계(xs)는 원하는 것보다 넓어서 px 로 정한 투명 그림을 끼워 간격을 만든다.
                            제목과 첫 요청 사이는 요청끼리의 간격보다 좁지 않게 둔다. 터미널에는 그림이 없어 간격도 없다 */}
                        {spacer(TITLE_GAP_PX)}
                        {canFold && resolvedToggle(task, resolvedCount, isResolvedFolded)}
                        {shownMessages.map((message, index) => {
                          const isDone = isResolvedIn(task, message)

                          // 요청은 작업 제목보다 한 단계 작은 글씨로 내려 제목과 구분하고, 표시와 글자 사이를 좁힌다. 처리한 요청은 회색 + 취소선
                          return (
                            <Box flexDirection="column">
                              {(index > 0 || canFold) && spacer(ROW_GAP_PX)}
                              <Box flexDirection="row" alignItems="center" gap="xs">
                                {checkbox(isDone)}
                                <Text size="footnote" color={isDone ? 'subtle' : undefined} strikethrough={isDone} wrap="wrap">
                                  {requestText(message)}
                                </Text>
                              </Box>
                            </Box>
                          )
                        })}
                      </Box>
                    )}
                    {/* 작업 완료·작업 취소는 요청 목록 아래 왼쪽에 둔다. plain 으로 글자 높이만 차지하고, 휴지통처럼 회색(dimColor)으로 둔다 */}
                    {/* 버튼 줄은 왼쪽에 붙이고, 요청 목록과는 작은 간격을 둔다.
                        터미널 글자 버튼은 그림 여백이 없어서 버튼 사이를 한 칸 띄우고 요청 목록과 같은 들여쓰기에서 시작한다 */}
                    {hasActions && (
                      <Box
                        flexDirection="row"
                        justifyContent="flex-start"
                        gap={e.surface === 'terminal' ? 1 : 0}
                        paddingLeft={e.surface === 'terminal' ? childInset : 0}
                        marginTop="xs"
                      >
                        {textButton(`done-${task.id}`, '작업 완료', () => setStatus($, task.id, 'done'))}
                        {textButton(`drop-${task.id}`, '작업 취소', () => setStatus($, task.id, 'dropped'))}
                      </Box>
                    )}
                  </Box>
                )
              })}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, ledger)
    const current = state.tasks.find(task => task.status === 'now')
    const unsorted = state.messages.filter(isUnsorted).length
    const counts = [
      ...byStatus(state.tasks)
        .filter(group => group.status !== 'dropped')
        .map(group => ({ label: LABEL[group.status], count: group.tasks.length })),
      ...(unsorted > 0 ? [{ label: '분류 전', count: unsorted }] : []),
    ]

    // 보여 줄 개수가 하나도 없으면(작업이 없거나 취소된 작업만 남은 경우) 한 줄을 그리지 않는다.
    // 그리면 「목록」 버튼만 있는 빈 줄이 된다.
    if (e.props.hasSurvey || counts.length === 0) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // 터미널 표에도 Svg 키가 있지만 아무것도 그리지 않는다: 그림 요소는 터미널이 아닐 때만 쓰고, 터미널은 글자로 대신한다
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const progress = current ? progressOf(state, current) : undefined

    return (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" alignItems="center" gap={2} flexShrink={1}>
          {current && (
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
              <Text bold wrap="truncate-end">
                {current.title}
              </Text>
              {/* 패널과 같은 순서: 숫자 → 막대 */}
              {progress && <Text color="subtle">{progressText(progress)}</Text>}
              {/* 막대가 왼쪽 숫자에 붙어 보이지 않게 다른 간격보다 한 단계 더 띄운다 */}
              {progress && Svg && (
                <Box marginLeft="xs" flexShrink={0}>
                  <Svg source={barSvg(progress, HEX.waiting, BAND_BAR_WIDTH)} alt={progressText(progress)} height={BAR_HEIGHT} />
                </Box>
              )}
            </Box>
          )}

          {/* 한 줄의 개수는 상태 이름·개수·구분점 모두 회색, 항목 사이는 ` · ` 로 촘촘하게 */}
          <Box flexDirection="row">
            {counts.map((item, index) => (
              <Box flexDirection="row">
                {index > 0 && <Text dimColor>{' · '}</Text>}
                <Text dimColor>{item.label}</Text>
                <Text dimColor>{` ${item.count}`}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        <Button key="open" label="목록" onPress={() => openPane($)} />
      </Box>
    )
  })
}
