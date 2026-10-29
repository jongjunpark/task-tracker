import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__task-tracker__tasks'

const PANE = {
  plugin: 'task-tracker',
  component: 'Pane',
  requestId: 'task-tracker',
  props: {
    title: '작업 목록',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

const BAND = {
  plugin: 'task-tracker',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

test('보낸 메시지는 훅이 기록하고, 모델에게 분류를 맡긴다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const seen: string[][] = []
  on('prompt.submit', (_, e) => {
    seen.push([...(e.context ?? [])])

    return { text: e.text, context: e.context }
  })

  await $.prompt.submit(typed('로그인 버그 고쳐줘'))
  await $.prompt.submit(typed('그리고 README 도 정리해줘'))

  expect(seen[0]?.join('\n')).toContain('m1')
  expect(seen[1]?.join('\n')).toContain('m2')
  expect(seen[1]?.join('\n')).toContain('Unclassified messages: m1, m2')
})

test('분류한 작업이 패널과 밴드에 상태별로 보인다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.prompt.submit(typed('로그인 버그 고쳐줘'))
  await $.prompt.submit(typed('README 도 정리해줘'))
  await $.prompt.submit(typed('아 소셜 로그인도 같이 봐줘'))
  const tool = await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', title: '로그인 버그 수정', message: 1, summary: '빈 화면 버그', status: 'now' },
      { op: 'add', title: 'README 정리', message: 2 },
      { op: 'attach', task: 1, message: 3, summary: '소셜 로그인 확인' },
      { op: 'resolve', message: 1 },
      { op: 'update', task: 1, doing: '재현 테스트 작성' },
    ],
  })

  // 모델에게는 남은 요청의 mN 을 알려 준다
  expect(String(tool.result)).toContain('#1 [진행] 로그인 버그 수정 (1/2; open: m3) — 재현 테스트 작성')

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /^진행 1$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^대기 1$/ })).toBeDefined()
    // 진행도는 작업에 붙은 요청 중 처리된 수
    expect((await pane.find({ type: 'Text', text: /^1\/2$/ }))?.text).toBe('1/2')
    // 처리된 요청(빈 화면 버그)은 「처리됨 1개」 줄로 접히고 남은 요청만 보인다
    expect(await pane.find({ key: 'resolved-1' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^빈 화면 버그$/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /^소셜 로그인 확인$/ })).toBeDefined()
    // 지금 하는 일(doing)은 모델용 목록에만 쓰고 패널에는 그리지 않는다
    expect(await pane.find({ type: 'Text', text: /재현 테스트 작성/ })).toBeUndefined()
    expect(await pane.find({ key: 'done-1' })).toBeDefined()
    // 메시지 번호(mN)는 모델용이라 화면에는 나오지 않는다
    expect(await pane.find({ type: 'Text', text: /\bm\d+\b/ })).toBeUndefined()
    await pane.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /^로그인 버그 수정$/ }))?.text).toBe('로그인 버그 수정')
    expect((await band.find({ type: 'Text', text: /^1\/2$/ }))?.text).toBe('1/2')
    expect(await band.find({ type: 'Text', text: /^진행$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /▶/ })).toBeUndefined()
    await band.unmount()
  }
})

test('다른 작업을 진행으로 올리면 하던 작업은 보류가 된다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', title: 'A 작업', status: 'now' },
      { op: 'add', title: 'B 작업', status: 'now' },
    ],
  })
  const done = await $.tool.call({ tool: TOOL, ops: [{ op: 'update', task: 2, status: 'done' }] })

  expect(String(done.result)).toContain('#1 [보류] A 작업')
  expect(String(done.result)).toContain('#2 [완료] B 작업')
})

test('완료 묶음의 비우기는 완료 작업만 지우고, 진행 중 묶음에는 비우기가 없다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', title: 'A 작업', status: 'done' },
      { op: 'add', title: 'B 작업', status: 'now' },
    ],
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 끝난 작업에만 하나씩 지우는 휴지통이 있다
  expect(await pane.find({ key: 'delete-2' })).toBeUndefined()
  expect(await pane.find({ key: 'delete-1' })).toBeDefined()
  // 그림 삼각형 위에 겹친 버튼으로 묶음이 접히고 펼쳐진다
  await pane.press({ key: 'group-now' })
  expect(await pane.find({ type: 'Text', text: /^B 작업$/ })).toBeUndefined()
  await pane.press({ key: 'group-now' })
  expect(await pane.find({ key: 'clear-now' })).toBeUndefined()
  await pane.press({ key: 'clear-done' })
  expect(await pane.find({ type: 'Text', text: /^A 작업$/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^B 작업$/ })).toBeDefined()
  await pane.unmount()
})

test('작업 줄의 휴지통은 그 작업 하나만 지운다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', title: 'A 작업', status: 'done' },
      { op: 'add', title: 'B 작업', status: 'done' },
    ],
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'delete-1' })
  expect(await pane.find({ type: 'Text', text: /^A 작업$/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^B 작업$/ })).toBeDefined()
  await pane.unmount()
})

test('작업이 상한을 넘으면 끝난 작업부터 지운다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  // 가장 오래된 1번은 대기, 2번은 완료. 101번째를 넣으면 2번이 지워져야 한다
  const ops = Array.from({ length: 101 }, (_, index) => ({
    op: 'add',
    title: `작업 ${index + 1}`,
    status: index === 1 ? 'done' : 'waiting',
  }))
  const result = await $.tool.call({ tool: TOOL, ops })

  expect(String(result.result)).toContain('#1 [대기] 작업 1')
  expect(String(result.result)).not.toContain('#2 [완료] 작업 2')
})

test('확인 필요는 할 일이 있어야 걸리고, 패널에 그 할 일이 보이며, 답이 붙으면 진행으로 돌아간다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.prompt.submit(typed('아이콘 바꿔줘'))
  await $.prompt.submit(typed('1번'))
  await $.tool.call({ tool: TOOL, ops: [{ op: 'add', title: '아이콘 교체', message: 1, status: 'now' }] })

  // 할 일 없이 확인 필요로 바꾸면 거절된다
  const refused = await $.tool.call({ tool: TOOL, ops: [{ op: 'update', task: 1, status: 'blocked' }] })
  expect(String(refused.result)).toContain('blocked needs `ask`')
  expect(String(refused.result)).toContain('#1 [진행] 아이콘 교체')

  await $.tool.call({ tool: TOOL, ops: [{ op: 'update', task: 1, status: 'blocked', ask: '아이콘을 1~3번 중 골라 주세요' }] })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^확인 필요 1$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^⤷ 아이콘을 1~3번 중 골라 주세요$/ })).toBeDefined()
  await pane.unmount()

  // 프롬프트 위 한 줄에는 할 일을 띄우지 않는다(개수만). 할 일은 패널에서 본다
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /⤷/ })).toBeUndefined()
  await band.unmount()

  // 답 메시지를 붙이면 진행으로 돌아가고 할 일은 지워진다
  const answered = await $.tool.call({ tool: TOOL, ops: [{ op: 'attach', task: 1, message: 2 }] })
  expect(String(answered.result)).toContain('(unblocked, now)')
  expect(String(answered.result)).toContain('#1 [진행] 아이콘 교체')
  expect(String(answered.result)).not.toContain('needs from person')
})

test('취소된 작업만 남으면 한 줄을 그리지 않는다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // 한 줄을 그리지 않으면 엔진 몫으로 넘어간다: 그 자리를 표시하는 글자로 대신한다
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.tool.call({ tool: TOOL, ops: [{ op: 'add', title: 'A 작업', status: 'dropped' }] })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'open' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
  await band.unmount()
})

test('모델에게 보내는 목록은 완료 작업을 최근 3개만 자세히, 나머지는 제목만 싣는다', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  // 완료 15개를 시간 차를 두고 만든 뒤 안 끝난 작업 1개
  for (let index = 1; index <= 15; index += 1) {
    await $.tool.call({ tool: TOOL, ops: [{ op: 'add', title: `끝난 작업 ${index}`, status: 'done' }] })
    await clock.advance(1_000)
  }
  const result = await $.tool.call({ tool: TOOL, ops: [{ op: 'add', title: '남은 작업', status: 'now' }] })
  const text = String(result.result)

  expect(text).toContain('#16 [진행] 남은 작업')
  // 최근 3개는 자세히
  expect(text).toContain('#15 [완료] 끝난 작업 15')
  expect(text).toContain('#13 [완료] 끝난 작업 13')
  expect(text).not.toContain('#12 [완료]')
  // 그보다 오래된 건 번호와 제목만, 10개까지
  expect(text).toContain('Done earlier: #12 끝난 작업 12')
  expect(text).toContain('(+2 more)')
})

test('터미널에서는 그림 대신 글자로 접기·비우기·진행 막대·체크를 그린다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.prompt.submit(typed('A 해줘'))
  await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', title: 'A 작업', message: 1, status: 'now' },
      { op: 'resolve', message: 1 },
      { op: 'add', title: 'B 작업', status: 'done' },
    ],
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 접기 삼각형은 글자 버튼
  expect((await pane.find({ key: 'group-now' }))?.text).toBe('\u25BC\uFE0E')
  // 모두 삭제·항목 삭제는 글자 버튼
  expect((await pane.find({ key: 'clear-done' }))?.text).toBe('모두 삭제')
  expect((await pane.find({ key: 'delete-2' }))?.text).toBe('삭제')
  // 진행 막대는 선 글자, 체크는 글자 ✓
  expect(await pane.find({ type: 'Text', text: /━/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
  await pane.unmount()
})

test('작업 완료 버튼은 남은 요청까지 작업 전체를 완료로 옮긴다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.prompt.submit(typed('A 해줘'))
  await $.prompt.submit(typed('A 에 이것도'))
  await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', title: 'A 작업', message: 1, status: 'now' },
      { op: 'attach', task: 1, message: 2 },
    ],
  })

  // 진행 중인 작업은 펼친 채로 보이므로 버튼을 바로 누를 수 있다
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^0\/2$/ }))?.text).toBe('0/2')
  // 제목을 누르면 요청 목록과 버튼이 접혔다 펼쳐진다
  await pane.press({ key: 'task-1' })
  expect(await pane.find({ key: 'done-1' })).toBeUndefined()
  await pane.press({ key: 'task-1' })
  await pane.press({ key: 'done-1' })
  expect(await pane.find({ type: 'Text', text: /^완료 1$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^진행 \d+$/ })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: /^2\/2$/ }))?.text).toBe('2/2')
  await pane.unmount()
})

test('처리된 요청은 남은 요청이 있을 때 「처리됨 N개」 한 줄로 접히고, 누르면 펼쳐진다', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.prompt.submit(typed('로그인 버그 고쳐줘'))
  await $.prompt.submit(typed('에러 문구도'))
  await $.prompt.submit(typed('테스트도 추가'))
  await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', title: '로그인 버그', message: 1, summary: '로그인 버그 수정', status: 'now' },
      { op: 'attach', message: 2, task: 1, summary: '에러 문구 수정' },
      { op: 'attach', message: 3, task: 1, summary: '테스트 추가' },
      { op: 'resolve', message: 1 },
      { op: 'resolve', message: 2 },
    ],
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ key: 'resolved-1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^로그인 버그 수정$/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^테스트 추가$/ })).toBeDefined()

  await pane.press({ key: 'resolved-1' })
  expect(await pane.find({ type: 'Text', text: /^로그인 버그 수정$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^에러 문구 수정$/ })).toBeDefined()

  // 전부 처리되면 접을 줄 없이 다 보인다
  await $.tool.call({ tool: TOOL, ops: [{ op: 'resolve', message: 3 }] })
  expect(await pane.find({ key: 'resolved-1' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^로그인 버그 수정$/ })).toBeDefined()
  await pane.unmount()
})
