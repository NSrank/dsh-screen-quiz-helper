/**
 * dsh-screen-quiz-helper —— 屏幕共享答题助手
 *
 * 全部能力自带，不依赖任何桌面操控插件：
 *   screencapture 截图 → bin/quiznative（Swift + Apple Vision）OCR → CoreGraphics 点击
 *
 * 工具：window_find / screen_capture / screen_ocr / mouse_click / mouse_move /
 *       screen_permissions / quiz_start / quiz_stop / quiz_status
 */

import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-screen-quiz-helper'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(HERE, 'bin', 'quiznative')
const SHOT_DIR = path.join(os.tmpdir(), 'dsh-screen-quiz')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ensureBinary() {
  try {
    fs.accessSync(BIN, fs.constants.X_OK)
  } catch {
    try {
      fs.chmodSync(BIN, 0o755) // 拷贝/解压后执行位可能丢失
      fs.accessSync(BIN, fs.constants.X_OK)
    } catch {
      throw new Error(`原生辅助程序缺失或不可执行: ${BIN}（可执行 chmod +x 或按 README 重新编译）`)
    }
  }
  return BIN
}

function run(args, timeoutMs = 20000) {
  const bin = ensureBinary()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`quiznative ${args[0]} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`无法启动 quiznative: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(err.trim() || out.trim() || `quiznative 退出码 ${code}`))
      resolve(out.trim())
    })
  })
}

async function runJSON(args, timeoutMs) {
  const text = await run(args, timeoutMs)
  try { return JSON.parse(text) } catch { throw new Error(`quiznative 返回非 JSON: ${text.slice(0, 200)}`) }
}

// ── 插件状态（答题循环在后台跑，工具只读写这里）───────────────────────────

const quiz = {
  running: false,
  stop: false,
  phase: 'idle',
  log: [],
  answered: [],
  attempts: new Map(),
  answeredPages: new Set(),
  pageRetries: new Map(),
  error: null,
  last: null,
  windowId: null,
  windowPid: null,
  clickMode: 'pointer',
  fuseCount: 0,
  perQuestionMs: [],
  startedAt: 0,
  finishedAt: 0,
}

function log(line) {
  quiz.log.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`)
  if (quiz.log.length > 300) quiz.log.splice(0, quiz.log.length - 300)
}

// ── 窗口 / 截图 / OCR ─────────────────────────────────────────────────────

async function listWindows() {
  return runJSON(['windows'])
}

async function findWindow(keyword = '屏幕共享') {
  const wins = await listWindows()
  const k = keyword.trim().toLowerCase()
  const exact = []
  const near = []
  for (const w of wins) {
    const title = (w.title || '').toLowerCase()
    const owner = (w.owner || '').toLowerCase()
    if (title === k || owner === k) {
      // 标题精确命中，或（标题为空但）应用本身就叫「屏幕共享」的窗口——真实共享窗口常没有标题
      let score = title === k ? 100 : 90
      if (owner === k) score += 60 // 应用本身就是「屏幕共享」时优先级最高，压过标题恰好同名的浏览器窗口
      if (w.sharing === 1) score += 5
      exact.push({ w, score, area: w.width * w.height })
    } else if (title.includes(k) || owner.includes(k)) {
      near.push(w)
    }
  }
  if (!exact.length) return { window: null, windows: wins, hits: [], near: near.slice(0, 8) }
  exact.sort((a, b) => b.score - a.score || b.area - a.area)
  return { window: exact[0].w, windows: wins, hits: exact.map((s) => s.w), near: near.slice(0, 8) }
}

function windowById(wins, id) {
  return wins.find((w) => w.windowId === id) || null
}

async function captureWindow(win) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `shot-${Date.now()}.png`)
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/sbin/screencapture', ['-x', '-o', `-l${win.windowId}`, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`screencapture 启动失败: ${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(file)) return reject(new Error(`screencapture 失败(${code}): ${err.trim()}`))
      resolve()
    })
  })
  // 只留最近 8 张，别把临时目录撑满
  try {
    const files = fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png')).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - 8))) fs.rmSync(path.join(SHOT_DIR, stale), { force: true })
  } catch {}
  return {
    pngPath: file,
    windowId: win.windowId,
    window: { x: win.x, y: win.y, width: win.width, height: win.height },
  }
}

// 重新抓一帧并解析，供「按钮没读到 / 选项没读到 / 翻页不稳」这类瞬时状态自愈使用
async function reparseOnce(window) {
  const shot = await captureWindow(window)
  const ocr = await ocrShot(shot)
  return { shot, ocr, parsed: parseQuiz(ocr), badges: await readBadges(window, shot) }
}

async function ocrShot(shot) {
  const w = shot.window
  const data = await runJSON(['ocr', shot.pngPath, String(w.x), String(w.y), String(w.width), String(w.height)], 30000)
  return {
    ...data,
    windowX: w.x,
    windowY: w.y,
    windowWidth: w.width,
    windowHeight: w.height,
    lines: data.lines.map((l) => ({
      text: l.text,
      confidence: l.confidence,
      x: l.x, y: l.y, width: l.width, height: l.height,
      centerX: l.centerX, centerY: l.centerY,
      center: { x: l.centerX, y: l.centerY },
    })),
  }
}

// ── 高分辨率局部重识别 ────────────────────────────────────────────────────

function execCmd(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败: ${(stderr || err.message).toString().slice(0, 200)}`))
      else resolve(stdout.toString())
    })
  })
}

async function cropOcr(window, x, y, w, h, scale = 3) {
  const rect = [x, y, w, h].map((v) => Math.round(v))
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const raw = `/tmp/dsh-quiz-crop-${stamp}.png`
  const big = `/tmp/dsh-quiz-crop-${stamp}-big.png`
  await execCmd('/usr/sbin/screencapture', ['-x', `-R${rect[0]},${rect[1]},${rect[2]},${rect[3]}`, raw])
  await execCmd('sips', ['--resampleWidth', String(Math.max(600, Math.round(rect[2] * scale))), raw, '--out', big])
  const data = await runJSON(['ocr', big, String(rect[0]), String(rect[1]), String(rect[2]), String(rect[3])], 30000)
  return data.lines.map((l) => ({ ...l, center: { x: l.centerX, y: l.centerY } }))
}

// 选项区整段裁剪 + 放大重识别：整窗 OCR 常漏掉某个徽标或把分数拆成两行
async function refineOptions(window, parsed, ocr) {
  const btn = parsed.next || parsed.submit
  const bottomY = btn ? btn.y - 10 : window.y + window.height - 20
  const optYs = parsed.options.map((o) => o.centerY)
  const topY = optYs.length ? Math.min(...optYs) - 36 : window.y + Math.max(120, window.height * 0.28)
  const y = Math.max(window.y + 40, Math.round(topY))
  const h = Math.round(Math.min(bottomY, window.y + window.height) - y)
  if (h < 80) return null
  const x = Math.round(window.x + 4)
  const w = Math.round(window.width - 8)
  let lines = []
  try {
    lines = await cropOcr(window, x, y, w, h, 3)
  } catch {
    return null
  }
  if (!lines.length) return null
  const keep = [parsed.next, parsed.submit].filter(Boolean).map((b) => ({
    text: b.text,
    confidence: 1,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    centerX: b.centerX,
    centerY: b.centerY,
    center: { x: b.centerX, y: b.centerY },
  }))
  const merged = parseQuiz({ ...ocr, lines: [...lines, ...keep] })
  return merged.options.length > parsed.options.length ? merged : null
}


const OPTION_RE = /^([A-HＡ-Ｈ]|[①②③④⑤⑥⑦⑧])\s*(?:[.、,．:：)）]|\s)\s*(.+)$/
const CIRCLE = { '①': 'A', '②': 'B', '③': 'C', '④': 'D', '⑤': 'E', '⑥': 'F', '⑦': 'G', '⑧': 'H' }
const NEXT_RE = /下一题|下一頁|下一页|next|Next|NEXT/
const SUBMIT_RE = /提交|交卷|submit|Submit|SUBMIT/

function toLetter(raw) {
  if (CIRCLE[raw]) return CIRCLE[raw]
  return raw.replace(/[Ａ-Ｈ]/, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toUpperCase()
}

function groupRows(lines, tolerance = 22) {
  // 把同一水平的 OCR 行合并成「行」：手机端答题界面选项字母是独立圆形徽标，和文字不在同一行高
  const sorted = [...lines].sort((a, b) => a.centerY - b.centerY || a.x - b.x)
  const rows = []
  for (const line of sorted) {
    const row = rows.find((r) => Math.abs(r.centerY - line.centerY) <= tolerance)
    if (row) {
      row.lines.push(line)
      row.centerY = (row.centerY * (row.lines.length - 1) + line.centerY) / row.lines.length
    } else {
      rows.push({ centerY: line.centerY, lines: [line] })
    }
  }
  return rows.map((row) => {
    const parts = [...row.lines].sort((a, b) => a.x - b.x)
    const x = Math.min(...parts.map((l) => l.x))
    const right = Math.max(...parts.map((l) => l.x + l.width))
    const top = Math.min(...parts.map((l) => l.y))
    const bottom = Math.max(...parts.map((l) => l.y + l.height))
    return {
      text: parts.map((l) => l.text.trim()).join(' '),
      x,
      y: top,
      width: right - x,
      height: bottom - top,
      centerX: (x + right) / 2,
      centerY: (top + bottom) / 2,
      confidence: Math.min(...parts.map((l) => l.confidence ?? 1)),
      lines: parts,
    }
  })
}

const LETTER_HEAD_RE = /^([A-HＡ-Ｈ]|[①②③④⑤⑥⑦⑧])\s*[.、,．:：)）]?\s*(.+)$/
const BADGE_RE = /^[（(]?\s*([A-HＡ-Ｈ]|[①②③④⑤⑥⑦⑧])\s*[）).、,．:：]?$/

function parseQuiz(ocr) {
  const contentTop = (ocr.windowY || 0) + Math.max(40, (ocr.windowHeight || 0) * 0.1)
  // 内容区：排除窗口标题栏 / 浏览器标签栏 / 地址栏（其中的「① 屏幕共享」会被误当成选项 A）
  const lines = ocr.lines.filter((l) => l.text.trim().length > 0 && l.y >= contentTop)
  const rows = groupRows(lines)

  // 按钮按单行定位：合并行可能把「答题卡 1/15 下一题」拼在一起，点击会点到别的按钮
  const buttons = []
  for (const line of lines) {
    const text = line.text.trim()
    if (SUBMIT_RE.test(text)) buttons.push({ ...line, kind: 'submit' })
    else if (NEXT_RE.test(text)) buttons.push({ ...line, kind: 'next' })
  }
  const isButtonLine = (l) => buttons.some((b) => b.text === l.text && Math.abs(b.y - l.y) < 1)
  const buttonRows = rows.filter((r) => r.lines.some(isButtonLine))

  const textX = (row) => {
    const texts = row.lines.filter((l) => !BADGE_RE.test(l.text.trim()))
    return texts.length ? Math.min(...texts.map((l) => l.x)) : row.x
  }
  const badgeOf = (row) => row.lines.find((l) => BADGE_RE.test(l.text.trim()) && l.width < 46) || null
  const alignX = (row) => {
    const badge = badgeOf(row)
    return badge ? badge.x : textX(row)
  }
  // 选项区：从按钮上方自下而上取「等间距的连续行」。该 App 的字母徽标常被 OCR 漏掉，
  // 所以不能只靠字母前缀判断；间距一致性可以把正文行（如分数式、题干折行）排除在外。
  const bodyCandidates = rows.filter((r) => !buttonRows.includes(r))
  let blockStart = bodyCandidates.length
  if (bodyCandidates.length) {
    blockStart = bodyCandidates.length - 1
    if (bodyCandidates.length >= 2) {
      const last = bodyCandidates[bodyCandidates.length - 1]
      const prev = bodyCandidates[bodyCandidates.length - 2]
      const step = last.centerY - prev.centerY
      const refX = alignX(last)
      const refTextX = textX(last)
      if (step >= 32 && step <= 110) {
        while (blockStart > 0) {
          const cur = bodyCandidates[blockStart]
          const up = bodyCandidates[blockStart - 1]
          const gap = cur.centerY - up.centerY
          if (gap < 30 || gap > 140) break
          // 题干/分数式与选项的起始 x 不同：字母徽标列或文字列任一列对齐即可
          if (Math.abs(alignX(up) - refX) > 22 && Math.abs(textX(up) - refTextX) > 22) break
          if (up.height > 46) break
          if (/单选题|多选题|判断题|填空题|答题卡|^\s*\d+\s*[.、]/.test(up.text)) break
          // 没有字母徽标、也不以「A.」开头、而且明显是整行长文的行 ＝ 题干，到此为止
          if (!badgeOf(up) && !LETTER_HEAD_RE.test(up.text.trim()) && up.width > 170) break
          const t = up.text.trim()
          // 题干行特征：以「（」结尾（选择题括号）、超长、或本身是整段文字
          if (up.width > 340 || /[（(]\s*[）)]?\s*$/.test(t) || (t.length > 12 && !LETTER_HEAD_RE.test(t))) break
          blockStart--
        }
      }
    }
    while (bodyCandidates.length - blockStart > 8) blockStart++
    // 分数式选项的间距不均匀（一步 90~120px、行高 50+），上面按等间距取不到 3 个以上选项时，
    // 改用「自下而上、间距 40~200、行宽不过分」的宽松规则，把整块选项收进来
    if (bodyCandidates.length - blockStart < 3) {
      let loose = bodyCandidates.length - 1
      while (loose > 0) {
        const cur = bodyCandidates[loose]
        const up = bodyCandidates[loose - 1]
        const gap = cur.centerY - up.centerY
        if (gap < 40 || gap > 200) break
        if (up.width > 260 || up.height > 90) break
        if (/单选题|多选题|判断题|填空题|答题卡/.test(up.text)) break
        if (!badgeOf(up) && !LETTER_HEAD_RE.test(up.text.trim()) && up.width > 170) break
        loose--
        if (bodyCandidates.length - loose > 8) break
      }
      if (bodyCandidates.length - loose >= 3) blockStart = loose
    }
  }
  let questionRows = bodyCandidates.slice(0, blockStart)
  const bodyRows = bodyCandidates.slice(blockStart)

  const options = []
  const seen = new Set()
  if (!options.length) bodyRows.forEach((row, index) => {
    const text = row.text.trim()
    const head = text.match(LETTER_HEAD_RE)
    let letter = head ? toLetter(head[1]) : null
    let body = head ? head[2].trim() : text
    if (letter && seen.has(letter)) { letter = null; body = text }
    if (!letter) {
      // 徽标被 OCR 漏掉时按行序补字母（该 App 的选项固定按 A/B/C/D 纵向排列）
      letter = 'ABCDEFGH'.split('').find((c) => !seen.has(c)) ?? 'ABCDEFGH'[index]
      body = text.replace(/^[•·・●○◦]\s*/, '').trim()
    }
    if (!body) return
    seen.add(letter)
    // 点击目标优先落在选项字母徽标本身（用户要求精确点 A/B/C/D 字符），没有徽标就点行首字母附近
    const badge = row.lines.find((l) => BADGE_RE.test(l.text.trim()) && l.width < 46)
    const clickX = badge ? badge.centerX : row.x + Math.min(18, row.width * 0.06)
    const clickY = badge ? badge.centerY : row.centerY
    options.push({ letter, text: body, line: row, centerX: row.centerX, centerY: row.centerY, clickX, clickY })
  })
  options.sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0))

  const question = questionRows.map((r) => r.text.trim()).filter((t) => !/https?:\/\/|file:\/\//.test(t)).join(' ').slice(0, 600)

  const nextBtn = buttons.filter((b) => b.kind === 'next').sort((a, b) => b.centerY - a.centerY || b.centerX - a.centerX)[0] || null
  const submitBtn = buttons.filter((b) => b.kind === 'submit').sort((a, b) => b.centerY - a.centerY || b.centerX - a.centerX)[0] || null

  // 页码只在底部找：公式里也有 a/b，全窗抓会抓错
  const bottomY = ocr.windowY + ocr.windowHeight * 0.62
  const okPair = (m) => m && Number(m[1]) <= Number(m[2]) && Number(m[2]) >= 2 && Number(m[2]) <= 300
  const pageMatch = ocr.lines
    .filter((l) => l.centerY > bottomY && l.text.trim().length <= 32)
    .map((l) => l.text.match(/(\d{1,3})\s*[/|｜]\s*(\d{1,3})/))
    .find(okPair)
  const page = pageMatch ? { index: Number(pageMatch[1]), total: Number(pageMatch[2]) } : null

  const signature = [
    question.replace(/\s+/g, ''),
    ...options.map((o) => `${o.letter}:${o.text.replace(/\s+/g, '')}`),
  ].join('|')

  return {
    question,
    options,
    next: nextBtn,
    submit: submitBtn,
    signature,
    page,
    bounds: { x: ocr.windowX, y: ocr.windowY, width: ocr.windowWidth, height: ocr.windowHeight },
  }
}

// 一次截图只跑一次原生徽标检测，结果供 badgeOptions / detectBadgeState / waitStable 复用，
// 避免同一张截图反复起子进程（每次约 60~120ms，100 题累计能省十几秒）。
async function readBadges(window, shot) {
  try {
    const res = await runJSON([
      'badges',
      shot.pngPath,
      String(Math.round(window.x)),
      String(Math.round(window.y)),
      String(Math.round(window.width)),
      String(Math.round(window.height)),
    ])
    return res.badges || []
  } catch {
    return []
  }
}

// 从原始徽标列表里取出「同一列、选项区内」的 y 序列（逻辑坐标），用于判断翻页是否发生、布局是否稳定
function badgeYsOf(window, raw) {
  const floorY = window.y + window.height * 0.25
  const limitY = window.y + window.height - 60
  let list = (raw || []).filter((b) => b.y > floorY && b.y < limitY && (b.h ?? 0) <= 34)
  if (list.length < 2) return null
  const xs = list.map((b) => b.x).sort((a, b) => a - b)
  const medianX = xs[Math.floor(xs.length / 2)]
  list = list.filter((b) => Math.abs(b.x - medianX) <= 8).sort((a, b) => a.y - b.y)
  if (list.length < 3) return null
  return list.map((b) => Math.round(b.y))
}

// 首选方案：按颜色检测 A/B/C/D 圆形徽标（不依赖 OCR 认出字母），再按顺序赋字母，
// 用 OCR 正文做文字校验。徽标的几何位置是确定性的，OCR 丢字母也不影响点击落点。
async function badgeOptions(window, shot, ocr, parsed, rawBadges) {
  const raw = rawBadges || (await readBadges(window, shot))
  const btn = parsed.next || parsed.submit
  const limitY = btn ? btn.y - 10 : window.y + window.height - 10
  const floorY = window.y + window.height * 0.25
  let list = (raw || []).filter((b) => b.y > floorY && b.y < limitY && (b.h ?? 0) <= 34)
  if (list.length < 2) return null
  // 徽标字母在同一列：先把偏离列的（公式笔画、按钮箭头）排掉
  const xs = list.map((b) => b.x).sort((a, b) => a - b)
  const medianX = xs[Math.floor(xs.length / 2)]
  list = list.filter((b) => Math.abs(b.x - medianX) <= 8).sort((a, b) => a.y - b.y)
  if (list.length < 2 || list.length > 8) return null
  // 交叉校验：每个徽标右侧 10~70pt 内必须有一条 OCR 正文行（徽标与正文不同行高，用 y ±26 容差）。
  // 颜色检测偶尔会把公式里的蓝色笔画/高亮文字当成徽标列（测到过 x 偏右 95pt 的假列），
  // 那种列右侧没有选项正文，直接用几何关系拒掉，交给局部裁剪方案。
  const textLines = (ocr.lines || []).filter((l) => !/下一题|上一题|答题卡|提交/.test(l.text))
  const consistent = list.every((b) =>
    textLines.some((l) => l.x > b.x + 10 && l.x < b.x + 70 && Math.abs(l.centerY - b.y) <= 26),
  )
  if (!consistent) return null
  // 只检出 2 个但 OCR 明显有多选的题：等距校验只剩一个 gap 形同虚设，
  // 字母会整体错位（B 其实是 C），宁可交给按行顺序重建的方案。
  if (list.length < 3 && (parsed.options || []).length >= 3) return null
  // 间距应当接近等距：否则说明把别的东西认成徽标了
  const gaps = []
  for (let i = 1; i < list.length; i++) gaps.push(list[i].y - list[i - 1].y)
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)]
  if (medianGap < 36) return null
  // 少检出一个徽标会让字母整体错位（点错选项），所以间距必须几乎等距，否则整组弃用
  const irregular = gaps.some((g) => g < medianGap * 0.75 || g > medianGap * 1.3)
  if (irregular) return null
  const letters = 'ABCDEFGH'
  return list.map((b, i) => {
    const text = (ocr.lines || [])
      .filter((l) => Math.abs(l.centerY - b.y) <= 24 && l.x > b.x + 6)
      .map((l) => l.text.trim())
      .filter((t) => t && !/下一题|上一题|答题卡|提交/.test(t))
      .join(' ')
    return {
      letter: letters[i],
      text,
      badgeOnly: !text,
      x: Math.round(b.x - 12),
      y: Math.round(b.y - 12),
      width: 24,
      height: 24,
      centerX: b.x,
      centerY: b.y,
      clickX: b.x,
      clickY: b.y,
    }
  })
}

// 选项区按「行顺序」重建：徽标经常漏检一个，但选项一定按 A/B/C/D 自上而下排列。
// 做法：整段选项区高分辨率裁剪 → 行聚类 → 顺序赋字母（分数分子/分母在一个槽位内合并）。
async function bandOptions(window, parsed, ocrLines = []) {
  const btn = parsed.next || parsed.submit
  const limitY = btn ? btn.y - 14 : window.y + window.height - 18
  // 徽标也来自整窗 OCR：即使整窗解析把行并错，徽标字母的 y 仍可当锚点
  const windowBadges = ocrLines.filter((l) => BADGE_RE.test(l.text.trim()))
  const anchorYs = [
    ...parsed.options.map((o) => o.centerY),
    ...windowBadges.map((b) => b.centerY),
  ].filter((v) => Number.isFinite(v))
  const top = anchorYs.length
    ? Math.max(window.y + 60, Math.round(Math.min(...anchorYs) - 30))
    : Math.max(window.y + 60, Math.round(window.y + window.height * 0.28))
  const h = Math.round(limitY - top)
  if (h < 90) return null
  const x = Math.round(window.x + 4)
  const w = Math.round(window.width - 8)
  let lines = []
  try {
    lines = await cropOcr(window, x, top, w, h, 3)
  } catch {
    return null
  }
  if (!lines.length) return null
  const skip = /下一题|上一题|答题卡|提交|^\d+\s*\/\s*\d+$/
  const badges = lines.filter((l) => BADGE_RE.test(l.text.trim()))
  const badgeMinX = badges.length
    ? Math.min(...badges.map((b) => b.x))
    : anchorYs.length
      ? Math.min(...parsed.options.map((o) => o.clickX ?? o.centerX)) - 10
      : window.x + 24
  const body = lines.filter(
    (l) => !BADGE_RE.test(l.text.trim()) && !skip.test(l.text.trim()) && l.x >= badgeMinX - 4,
  )
  if (!body.length && !badges.length) return null
  // 槽位 = 徽标中心 ∪ 正文行中心，按间距聚类：同一选项的徽标、分子、分母落在一起
  const points = [
    ...badges.map((b) => ({ cy: b.centerY, badge: b })),
    ...body.map((r) => ({ cy: r.centerY, row: r })),
  ].sort((a, b) => a.cy - b.cy)
  const slots = []
  for (const pt of points) {
    const last = slots[slots.length - 1]
    if (last && pt.cy - last.maxY < 46) {
      last.points.push(pt)
      last.maxY = Math.max(last.maxY, pt.cy)
      continue
    }
    slots.push({ points: [pt], maxY: pt.cy })
  }
  if (slots.length < 2 || slots.length > 8) return null
  const letters = 'ABCDEFGH'
  const fallbackX = badges.length
    ? badges.map((b) => b.centerX).sort((a, b) => a - b)[Math.floor(badges.length / 2)]
    : Math.min(...parsed.options.map((o) => o.clickX ?? o.centerX))
  const options = []
  for (const [i, slot] of slots.entries()) {
    const text = slot.points
      .filter((p) => p.row)
      .map((p) => p.row.text.trim())
      .filter(Boolean)
      .join(' ')
    const badge = slot.points.find((p) => p.badge)?.badge
    const cy = slot.points.reduce((sum, p) => sum + p.cy, 0) / slot.points.length
    const letter = letters[i]
    if (!letter) break
    if (!text && !badge) continue
    options.push({
      letter,
      text: text || badge.text.trim(),
      badgeOnly: !text && Boolean(badge),
      x: Math.round(window.x + 4),
      y: Math.round(cy - 20),
      width: window.width - 8,
      height: 40,
      centerX: badge ? badge.centerX : fallbackX,
      centerY: badge ? badge.centerY : Math.round(cy),
      clickX: badge ? badge.centerX : fallbackX,
      clickY: badge ? badge.centerY : Math.round(cy),
    })
  }
  return options.length >= 2 ? options : null
}

// 徽标漏检时的几何补齐：已识别选项等间距排列，缺的行按步长预测，
// 再用局部高分屏 OCR 验证该行确实有选项文字（无文字就不补、不点）
async function inferMissingOptions(window, parsed) {
  const opts = [...parsed.options].sort((a, b) => a.centerY - b.centerY)
  if (opts.length < 2) return parsed
  const steps = []
  for (let i = 1; i < opts.length; i++) steps.push(opts[i].centerY - opts[i - 1].centerY)
  const step = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)]
  if (!(step > 20 && step < 200)) return parsed
  const bx = Math.round(opts.reduce((sum, o) => sum + (o.clickX ?? o.centerX), 0) / opts.length)
  const btn = parsed.next || parsed.submit
  const limitY = btn ? btn.y - 24 : window.y + window.height - 20
  const letters = 'ABCDEFGH'
  const added = []
  let y = opts[opts.length - 1].centerY + step
  while (y < limitY && added.length < 4) {
    const h = Math.max(100, Math.round(step * 1.6))
    const x = window.x + 6
    const w = window.width - 12
    let text = ''
    try {
      const lines = await cropOcr(window, x, Math.round(y - h / 2), w, h, 4)
      text = lines
        .filter((l) => Math.abs(l.centerY - y) <= step * 0.6)
        .map((l) => l.text.trim())
        .filter((t) => t && !/下一题|上一题|答题卡|提交|\d\s*\/\s*\d/.test(t))
        .join(' ')
    } catch {
      text = ''
    }
    if (!text) break
    const letter = letters[opts.length + added.length]
    if (!letter) break
    added.push({
      letter,
      text,
      x,
      y: Math.round(y - h / 2),
      width: w,
      height: h,
      centerX: x + w / 2,
      centerY: y,
      clickX: bx,
      clickY: y,
    })
    y += step
  }
  if (!added.length) return parsed
  return { ...parsed, options: [...parsed.options, ...added] }
}

// ── 模型作答 ─────────────────────────────────────────────────────────────

function buildPrompt(parsed, hasImage, extraText) {
  const lines = [
    hasImage
      ? '附图是题目原图的放大裁剪，请直接看图作答；下面 OCR 文本仅作参考。'
      : '下面是题目的屏幕 OCR 文本（当前模型不能读图）。',
  ]
  if (!hasImage) {
    lines.push('OCR 已知缺陷：b 读成 6、∞ 读成 0、≠ 读成 +、指数丢失（y=x⁴ 只剩 y=x）、分数被拆成多行、ln 读成 In。')
  }
  lines.push(
    '无法确定唯一答案时只输出 UNSURE；否则只输出选项字母（A/B/C/D），不要解释、不要标点。',
    '',
    `题目：${parsed.question || '(题目文字未识别，请根据选项判断)'}`,
    '选项：',
    ...parsed.options.map((o) => `${o.letter}. ${o.text || '(仅识别到徽标)'}`),
  )
  if (extraText) {
    lines.push('', '【题目区高分重识别文本（与上面同源，OCR 结果可能略有差异，请互相参照）】', extraText)
  }
  return lines.join('\n')
}

async function buildImageBlock(ctx, pngPath) {
  if (!pngPath) return null
  const attachments = ctx.get('attachments')
  if (!attachments?.saveImage) return null
  try {
    const { readFile } = await import('node:fs/promises')
    const data = await readFile(pngPath)
    const ref = await attachments.saveImage({
      data: new Uint8Array(data),
      mediaType: 'image/png',
      name: 'quiz-shot.png',
    })
    return { type: 'image', attachment: ref }
  } catch {
    return null
  }
}

// 题目+选项区整段裁剪放大：公式/分数在整屏截图里太小，放大后模型看得更清。
async function buildQuestionCrop(ctx, parsed) {
  const b = parsed.bounds
  const btn = parsed.next || parsed.submit
  if (!b || !b.width) return null
  const top = Math.round(b.y + Math.max(40, b.height * 0.16))
  const bottom = btn ? Math.round(btn.y - 6) : Math.round(b.y + b.height - 12)
  const x = Math.round(b.x + 2)
  const w = Math.round(b.width - 4)
  const h = bottom - top
  if (h < 120) return null
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const raw = `/tmp/dsh-quiz-qcrop-${stamp}.png`
  const big = `/tmp/dsh-quiz-qcrop-${stamp}-big.png`
  try {
    await execCmd('/usr/sbin/screencapture', ['-x', `-R${x},${top},${w},${h}`, raw])
    await execCmd('sips', ['--resampleWidth', String(Math.min(960, Math.max(720, Math.round(w * 2)))), raw, '--out', big])
  } catch {
    return null
  }
  const block = await buildImageBlock(ctx, big)
  try { fs.rmSync(raw, { force: true }); fs.rmSync(big, { force: true }) } catch {}
  return block
}

// 无图模型下：把题目+选项区高分裁剪重识别一遍，作为纯文本的补充来源（公式仍可能残缺）。
async function buildHighResText(window, parsed) {
  const b = parsed.bounds
  const btn = parsed.next || parsed.submit
  const top = Math.round(b.y + Math.max(40, b.height * 0.16))
  const bottom = btn ? Math.round(btn.y - 6) : Math.round(b.y + b.height - 12)
  const x = Math.round(b.x + 2)
  const w = Math.round(b.width - 4)
  const h = bottom - top
  if (h < 120) return ''
  try {
    const lines = await cropOcr(window, x, top, w, h, 3)
    const text = lines.map((l) => (l.text || '').trim()).filter(Boolean).join('\n')
    return text.length > 10 ? text : ''
  } catch {
    return ''
  }
}

async function askModel(ctx, parsed, pngPath, window, timeoutMs = 15000) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('LLM 服务不可用，无法自动作答')
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (!selection?.provider || !selection?.model) throw new Error('未取得默认模型，无法自动作答')

  // 探测当前模型是否支持图片输入（参考 dsh-computer-use 的 screenshot 门禁），
  // 不支持图时发图只会变成占位文本，纯属浪费且干扰，改为只发文字 + 高分 OCR 补充。
  let canImage = false
  try {
    const info = await llm.resolveModelInfo?.(selection.provider, selection.model)
    canImage = !!(info?.inputModalities?.includes?.('image'))
  } catch {
    canImage = false
  }
  log(`模型 ${selection.model} ${canImage ? '支持图片输入，发送截图' : '不支持图片输入，仅发 OCR 文本（公式可能残缺）'}`)

  const content = [{ type: 'text', text: buildPrompt(parsed, canImage, '') }]
  if (canImage) {
    // 只发「题目区放大裁剪」这一张图：整屏图信息冗余、图片 token 更贵也更慢
    const crop = (await buildQuestionCrop(ctx, parsed)) || (await buildImageBlock(ctx, pngPath))
    if (crop) {
      content[0] = { type: 'text', text: buildPrompt(parsed, true, '') }
      content.push(crop)
    }
  } else {
    const extra = await buildHighResText(window, parsed)
    if (extra) {
      content[0] = { type: 'text', text: buildPrompt(parsed, false, extra) }
    }
  }
  const messages = [{ role: 'user', content }]
  let text = ''
  let reasoning = ''
  // 思考熔断：单题超过 timeoutMs 未返回就直接中止流，避免模型卡在一道题上把整轮拖死
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort() } catch {} }, timeoutMs)
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      messages,
      system: '你是答题助手。只输出一个选项字母。',
      temperature: 0,
      maxTokens: 400,
      signal: ac.signal,
      purpose: 'screen-quiz',
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text ?? ''
      else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text?.length > text.length) text = chunk.block.text
    }
    // 中止后适配器通常只是结束流、不抛异常：这里必须自己判定成熔断
    if (ac.signal.aborted) {
      const err = new Error(`思考熔断：超过 ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`} 未返回答案`)
      err.code = 'QUIZ_TIMEOUT'
      throw err
    }
  } catch (e) {
    if (ac.signal.aborted) {
      const err = new Error(`思考熔断：超过 ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`} 未返回答案`)
      err.code = 'QUIZ_TIMEOUT'
      throw err
    }
    throw new Error(`模型调用失败: ${e.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (ac.signal.aborted) {
    const err = new Error(`思考熔断：超过 ${Math.round(timeoutMs / 1000)}s 未返回答案`)
    err.code = 'QUIZ_TIMEOUT'
    throw err
  }
  const answer = text.trim()
  if (/UNSURE|不确定|无法确定/i.test(answer)) {
    const err = new Error(`模型无法确定该题答案：${parsed.question.slice(0, 60)}`)
    err.code = 'QUIZ_UNSURE'
    throw err
  }
  if (answer) return answer
  // 推理模型可能把预算都花在思维链上，正文为空：退回从推理文本末尾找答案
  const m = reasoning.match(/(?:^|[^A-Za-z])([A-H])(?![A-Za-z])/g)
  if (m && m.length) return m[m.length - 1].replace(/[^A-H]/g, '')
  {
    const err = new Error(`模型没有返回答案（正文 ${text.length} 字，推理 ${reasoning.length} 字）`)
    err.code = 'QUIZ_NOANSWER'
    throw err
  }
}

function pickOption(options, answer) {
  const direct = answer.match(/(?:^|[^A-Za-z])([A-H])(?:[^A-Za-z]|$)/)
  if (direct) {
    const hit = options.find((o) => o.letter === direct[1])
    if (hit) return hit
  }
  const plain = answer.replace(/\s+/g, '')
  const byText = options.find((o) => o.text.replace(/\s+/g, '') && (plain.includes(o.text.replace(/\s+/g, '')) || o.text.replace(/\s+/g, '').includes(plain)))
  return byText || null
}

function inside(option, bounds) {
  const x = option.centerX
  const y = option.centerY
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return x > bounds.x && x < bounds.x + bounds.width &&
    y > bounds.y && y < bounds.y + bounds.height
}

// ── 答题循环 ─────────────────────────────────────────────────────────────

// ── 每步操作后的状态校验 ────────────────────────────────────────────────
// 用户要求：每执行一次操作就截图快速判断状态（题号/选项对应/操作是否真的执行）。
// 关键信号：选项 A/B/C/D 是蓝色圆形徽标，未选中是细圆环（高约 11 逻辑点），
// 选中后变成实心蓝圆（高约 30 逻辑点）。据此可以确定性判断「哪个选项当前被选中」。

// 返回 { hasBadges, selected, badges }：selected 是当前被选中的徽标（实心圆），
// hasBadges 表示界面上到底有没有可检测的蓝色徽标（无徽标的纯文字界面则跳过校验）。
async function detectBadgeState(window, shot, parsed, rawBadges, ignoreButtons = false) {
  const raw = rawBadges || (await readBadges(window, shot))
  const btn = ignoreButtons ? null : parsed?.next || parsed?.submit
  const limitY = btn ? btn.y - 10 : window.y + window.height - 10
  const floorY = window.y + window.height * 0.25
  const list = (raw || []).filter((b) => b.y > floorY && b.y < limitY && (b.h ?? 0) <= 34)
  if (list.length < 2) return { hasBadges: false, selected: null }
  const sorted = [...list].sort((a, b) => (b.h ?? 0) - (a.h ?? 0))
  const filled = sorted[0]
  const rest = sorted.slice(1).map((b) => b.h ?? 0).sort((a, b) => a - b)
  const restMedian = rest.length ? rest[Math.floor(rest.length / 2)] : 0
  const restMax = rest.length ? rest[rest.length - 1] : 0
  const stateXs = list.map((b) => b.x).sort((a, b) => a - b)
  const stateMedianX = stateXs[Math.floor(stateXs.length / 2)]
  // 选中态必须是明显的离群实心圆：比其余徽标高 2 倍以上，且其余徽标都还是圆环高度（≤17）。
  // 否则（例如某个 band 把徽标和邻近蓝色内容粘在一起）宁可不认，避免把「没作答」误判成「已作答」。
  const selected =
    filled &&
    rest.length >= 1 &&
    (filled.h ?? 0) >= 20 &&
    (filled.h ?? 0) >= restMedian * 2 &&
    restMax <= 17 &&
    Math.abs(filled.x - stateMedianX) <= 10
      ? filled
      : null
  return { hasBadges: true, selected, badges: list }
}

// 等待选项布局稳定：翻页后选项徽标有一段短暂的位移动画，动画期间徽标 y 坐标会漂移，
// 直接按当时的坐标点会点错（实测 Q3 动画中 D 被读成 y=598，稳定后是 y=642）。
// 连续两次徽标检测的 y 集合一致（±3 逻辑点）才算稳定；连续两次读不到徽标说明不是动画，交给下游处理。
async function waitStable(window, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let prevYs = null
  let nullCount = 0
  while (true) {
    let shot = null
    let raw = []
    try {
      shot = await captureWindow(window)
      raw = await readBadges(window, shot)
    } catch {
      // 忽略单次截图/检测失败
    }
    const ys = badgeYsOf(window, raw)
    if (ys && prevYs && ys.length === prevYs.length && ys.every((v, i) => Math.abs(v - prevYs[i]) <= 3)) {
      return { stable: true, shot, badges: raw, ys }
    }
    if (!ys) {
      nullCount++
      if (nullCount >= 2) return { stable: false, shot, badges: raw, ys: null }
    }
    if (Date.now() >= deadline) return { stable: false, shot, badges: raw, ys }
    prevYs = ys
    await sleep(200)
  }
}

// 极轻量的翻页探测：只截图 + 检测徽标位置，不做整窗 OCR，通常 150~450ms 就能判定。
// 徽标 y 序列相对本题发生变化（长度不同或任一项差 >4）即可认为翻页成功。
// 两个信号任一成立即认为翻页成功：
//   ① 本题刚点的选中实心圆消失了（新页面没有选中项）—— 最可靠，连续两题选项布局完全一样时也能判对；
//   ② 徽标 y 序列变了（题目高度不同）。
async function waitAdvanceFast(window, prevYs, prevFilledY = null, timeoutMs = 2500) {
  if (!prevYs && prevFilledY == null) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(150)
    try {
      const shot = await captureWindow(window)
      const raw = await readBadges(window, shot)
      if (prevFilledY != null) {
        const filled = await detectBadgeState(window, shot, null, raw, true)
        if (!filled.selected) {
          await sleep(100)
          return true
        }
      }
      const ys = badgeYsOf(window, raw)
      if (ys && prevYs && ys.length) {
        const same = ys.length === prevYs.length && ys.every((v, i) => Math.abs(v - prevYs[i]) <= 4)
        if (!same) {
          await sleep(120)
          return true
        }
      }
    } catch {
      // 忽略单次失败
    }
  }
  return false
}

// 点击选项后校验：被点的那个选项徽标必须真的变高亮（选中）。没生效重试一次，仍不生效就停。
async function verifySelection(window, choice, parsed) {
  const targetY = choice.clickY ?? choice.centerY
  // 轮询而非固定等待：界面通常 150~250ms 内就重绘完成，固定 sleep 500 是纯浪费
  const check = async (ms) => {
    const deadline = Date.now() + ms
    let state = { hasBadges: false, selected: null }
    while (Date.now() < deadline) {
      await sleep(120)
      try {
        const shot = await captureWindow(window)
        state = await detectBadgeState(window, shot, parsed)
      } catch {
        continue
      }
      if (state.selected) return state
    }
    return state
  }
  const hit = (state) => state.selected && Math.abs(state.selected.y - targetY) <= 16
  let state = await check(900)
  if (!state.hasBadges) {
    state = await check(400)
    if (!state.hasBadges) {
      log('选中态校验：此界面无蓝色徽标，跳过校验')
      return { ok: true, skipped: true }
    }
  }
  if (hit(state)) {
    log(`选中态校验通过：${choice.letter} 徽标已高亮 @(${Math.round(state.selected.x)},${Math.round(state.selected.y)})`)
    return { ok: true }
  }
  if (state.selected) {
    throw new Error(`点击后选中的不是 ${choice.letter}（期望 y≈${Math.round(targetY)}，实得 y≈${Math.round(state.selected.y)}），选项坐标映射异常，已停止`)
  }
  log(`点击 ${choice.letter} 后未检测到选中态，重试一次`)
  await runJSON(['clickpid', String(window.pid), String(Math.round(choice.clickX ?? choice.centerX)), String(Math.round(choice.clickY ?? choice.centerY)), '1', String(window.windowId), quiz.clickMode])
  state = await check(900)
  if (hit(state)) {
    log(`选中态校验通过（重试后）：${choice.letter} @(${Math.round(state.selected.x)},${Math.round(state.selected.y)})`)
    return { ok: true }
  }
  throw new Error(`点击 ${choice.letter} 两次后仍未检测到选中态，已停止（未点下一题）`)
}

async function clickNext(window, parsed) {
  await runJSON(['clickpid', String(window.pid), String(parsed.next.centerX), String(parsed.next.centerY), '1', String(window.windowId), quiz.clickMode])
}

async function runQuiz(ctx, options) {
  const keyword = options.keyword || '屏幕共享'
  try {
    const perms = await runJSON(['perms'])
    if (!perms.screenCapture || !perms.accessibility) {
      throw new Error(
        `权限不足：${!perms.screenCapture ? '未开启「屏幕录制」' : ''}${!perms.screenCapture && !perms.accessibility ? '，' : ''}${!perms.accessibility ? '未开启「辅助功能」' : ''}。请在 系统设置 → 隐私与安全性 中为运行 DSH 的宿主进程开启后重启宿主进程。`
      )
    }
    const { window, near } = await findWindow(keyword)
    if (!window) {
      const hint = near.length
        ? `当前只有相近的窗口：${near.map((w) => `${w.owner}«${w.title}»`).join('、')}（标题必须精确等于「${keyword}」才会使用）`
        : '当前没有任何标题包含该关键词的窗口'
      throw new Error(`未找到标题精确为「${keyword}」的窗口。${hint}。请先打开屏幕共享窗口再开始答题。`)
    }
    quiz.windowId = window.windowId
    quiz.windowPid = window.pid
    log(`定位窗口 #${window.windowId} ${window.owner} «${window.title}» @(${Math.round(window.x)},${Math.round(window.y)}) ${Math.round(window.width)}×${Math.round(window.height)}`)
    await run(['activate', String(window.windowId)])
    await sleep(300)

    quiz.clickMode = options.clickMode || 'pointer'
    let rounds = 0
    // maxQuestions 只数「真正作答（含熔断跳过）」的题；已经答过的页只翻页不计数。
    const maxAnswers = options.maxQuestions || 60
    const hardCap = maxAnswers + 15
    while (!quiz.stop && quiz.answered.length < maxAnswers && rounds < hardCap) {
      rounds++
      // 翻页后选项徽标有短暂位移动画，动画期间 y 会漂移导致点错；先等布局稳定再截图。
      // waitStable 返回它最后一次稳定截图与徽标检测结果，后面直接复用，省掉一次截图+一次原生检测。
      const roundStart = Date.now()
      let stable = await waitStable(window)
      if (!stable.stable && !stable.ys) {
        // 版面还没渲染出徽标（切题动画/重绘），再给一轮；拿不到稳定版面才继续
        await sleep(250)
        const again = await waitStable(window)
        if (again.stable || again.ys) stable = again
      }
      let shot = stable.shot || (await captureWindow(window))
      let badgeRaw = stable.badges || (await readBadges(window, shot))
      let ocr = await ocrShot(shot)
      let parsed = parseQuiz(ocr)

      if (!parsed.options.length) {
        // 可能正在切题/渲染，给一次机会；两次都读不到选项就判定异常
        await sleep(400)
        shot = await captureWindow(window)
        badgeRaw = await readBadges(window, shot)
        ocr = await ocrShot(shot)
        parsed = parseQuiz(ocr)
        if (!parsed.options.length) throw new Error('检测到界面异常，请人工检查（连续两次截图都没有识别到选项）')
      }
      const roundYs = badgeYsOf(window, badgeRaw)

      {
        // 选项区定位优先级：徽标颜色检测（确定性）> 高分辨率局部裁剪聚类 > 整窗 OCR
        const byBadge = await badgeOptions(window, shot, ocr, parsed, badgeRaw)
        if (byBadge) {
          parsed = { ...parsed, options: byBadge }
          log(`选项定位（徽标检测）：${byBadge.length} 个（${byBadge.map((o) => o.letter).join('')}）`)
        }
        const band = byBadge ? null : await bandOptions(window, parsed, ocr.lines)
        if (band && band.length >= 2 && band.length <= 8) {
          parsed = { ...parsed, options: band }
          log(`选项定位：${band.length} 个（${band.map((o) => o.letter).join('')}）`)
        }
      }

      quiz.last = {
        question: parsed.question,
        options: parsed.options.map((o) => `${o.letter}. ${o.text}`),
        next: parsed.next?.text || null,
        submit: parsed.submit?.text || null,
      }

      const pageIdx = parsed.page?.index ?? null

      // ── 三重防重复 ─────────────────────────────────────────────
      // ① 视觉校验：这一题已经有一个选中项（实心徽标），说明之前已答过、翻页没成功
      //    （或退回旧题）。不要重复作答，直接重试点「下一题」。
      const preState = await detectBadgeState(window, shot, parsed, badgeRaw)
      log(`第 ${pageIdx ?? '?'} 题（已答页：${[...quiz.answeredPages].join(',') || '无'}；选中项：${preState.selected ? Math.round(preState.selected.y) : '无'}）`)
      if (preState.selected) {
        // 截图是本轮 waitStable 刚拍的，版面已经是当前状态，不需要再干等一轮探测：
        // 直接点「下一题」，点完再用 waitAdvanceFast 确认（每省一次探测约省 1.5s）。
        const key = pageIdx != null ? `p${pageIdx}` : parsed.signature
        const retries = (quiz.pageRetries.get(key) || 0) + 1
        quiz.pageRetries.set(key, retries)
        if (retries > 2) throw new Error(`第 ${pageIdx ?? '?'} 题已作答但翻页未成功，重试 ${retries - 1} 次仍停在同一题，请人工检查`)
        log(`该题已有选中项（不重复作答），重试点击「下一题」(${retries}/2)`)
        if (parsed.next) {
          await clickNext(window, parsed)
          await waitAdvanceFast(window, roundYs, preState.selected.y, options.advanceTimeout ?? 2000)
          continue
        }
        finish('该题已作答（已有选中项），请人工提交')
        return
      }

      // ② 页码校验：同一页码已经答过（无徽标界面的兜底）
      // 记录可能与现场不符（页码解析错位/别的题占了同一页码）：有徽标但没有任何选中项时，
      // 说明这一页其实还没答，清掉脏记录继续作答，绝不因为一条过期记录跳题。
      if (pageIdx != null && quiz.answeredPages.has(pageIdx) && preState.hasBadges && !preState.selected) {
        quiz.answeredPages.delete(pageIdx)
        log(`第 ${pageIdx} 题记录为已答，但界面无选中项，按未作答处理`)
      }
      if (pageIdx != null && quiz.answeredPages.has(pageIdx)) {
        const advanced = await waitAdvanceFast(window, roundYs, null, 2500)
        if (advanced) continue
        const key = `p${pageIdx}`
        const retries = (quiz.pageRetries.get(key) || 0) + 1
        quiz.pageRetries.set(key, retries)
        if (retries > 2) throw new Error(`第 ${pageIdx} 题翻页后仍停在同一页，已重试 ${retries - 1} 次，请人工检查`)
        log(`仍在第 ${pageIdx} 题，重试点击「下一题」(${retries}/2)`)
        if (parsed.next) {
          await clickNext(window, parsed)
          await sleep(options.stepDelay ?? 300)
          continue
        }
      }

      // ③ 签名校验：同一题 OCR 文本一致地反复出现
      const seen = quiz.attempts.get(parsed.signature) || 0
      if (seen >= 2) throw new Error(`同一题已连续出现 ${seen + 1} 次，停止以免重复作答：${parsed.question.slice(0, 50)}`)
      quiz.attempts.set(parsed.signature, seen + 1)

      // 最后一题（只剩「提交」）也要作答，只是不点提交
      // 「下一题」和「提交」都没读到时不能当成末题（曾把 OCR 抖动误判成最后一题而提前收工）
      if (!parsed.next && !parsed.submit) {
        // 翻页动画/重绘期间底部按钮行可能整行读不到：重抓两次再判，不能一次没读到就报错
        let healed = false
        for (let i = 0; i < 2 && !healed; i++) {
          await sleep(250)
          try {
            const re = await reparseOnce(window)
            if (re.parsed.next || re.parsed.submit) {
              shot = re.shot
              ocr = re.ocr
              badgeRaw = re.badges
              parsed = re.parsed
              healed = true
              log(`底部按钮首帧未识别，重抓 ${i + 1} 次后恢复`)
            }
          } catch {
            // 重抓失败继续
          }
        }
        if (!healed) throw new Error('既没有识别到「下一题」也没有识别到「提交」，界面可能异常，已停止（未点击）')
      }
      const lastQuestion = !parsed.next && !!parsed.submit

      const qTimeout = options.questionTimeoutMs ?? 15000
      let answer
      try {
        answer = await askModel(ctx, parsed, shot.pngPath, window, qTimeout)
      } catch (e) {
        if (e.code === 'QUIZ_TIMEOUT' || e.code === 'QUIZ_UNSURE' || e.code === 'QUIZ_NOANSWER' || e.code === 'QUIZ_NOMAP') {
          // 思考熔断：模型卡住或明确说无法确定 —— 不在这道题上耗时间，记一笔直接跳过
          const why = e.code === 'QUIZ_TIMEOUT'
            ? `超过 ${qTimeout >= 1000 ? `${Math.round(qTimeout / 1000)}s` : `${qTimeout}ms`} 未作答`
            : e.code === 'QUIZ_NOANSWER'
              ? '模型未返回答案（可用输出被思维链占满）'
              : e.code === 'QUIZ_NOMAP'
                ? '答案字母与识别到的选项对不上（选项定位不完整）'
                : '模型无法确定答案'
          log(`思考熔断（${why}），跳过第 ${pageIdx ?? '?'} 题`)
          quiz.answered.push({ question: parsed.question.slice(0, 80), answer: `(熔断跳过：${why})` })
          quiz.fuseCount = (quiz.fuseCount || 0) + 1
          if (pageIdx != null) quiz.answeredPages.add(pageIdx)
          if (lastQuestion) {
            finish('最后一题熔断跳过，请人工处理并提交')
            return
          }
          await clickNext(window, parsed)
          await waitAdvanceFast(window, roundYs, null, options.advanceTimeout ?? 2000)
          continue
        }
        throw e
      }
      let choice = pickOption(parsed.options, answer)
      if (!choice) {
        const band = await bandOptions(window, parsed, ocr.lines)
        if (band) {
          const retry = pickOption(band, answer)
          if (retry) {
            parsed = { ...parsed, options: band }
            choice = retry
            log(`答案字母 ${answer} 未识别，选项区按行顺序重建后定位到选项 ${retry.letter}`)
          }
        }
      }
      if (!choice) {
        const filled = await inferMissingOptions(window, parsed)
        if (filled.options.length > parsed.options.length) {
          parsed = filled
          const retry = pickOption(parsed.options, answer)
          if (retry) {
            choice = retry
            log(`答案字母 ${answer} 未识别，几何补齐 + 局部 OCR 校验后定位到选项 ${retry.letter}`)
          }
        }
      }
      if (!choice) {
        const better = await refineOptions(window, parsed, ocr)
        if (better) {
          const retry = pickOption(better.options, answer)
          if (retry) {
            parsed = { ...better, question: parsed.question || better.question }
            choice = retry
            log(`答案字母 ${answer} 在整窗 OCR 中缺失，已用高分屏局部重识别定位到选项 ${retry.letter}`)
          }
        }
      }
      if (!choice) {
        // 文字-坐标二次校验失败：重新截图识别一次，仍不匹配就停，绝不点不确定坐标
        const shot2 = await captureWindow(window)
        const ocr2 = await ocrShot(shot2)
        const parsed2 = parseQuiz(ocr2)
        const choice2 = pickOption(parsed2.options, answer)
        if (!choice2) {
          const err = new Error(`答案「${answer}」无法与识别到的选项文字匹配（选项：${parsed.options.map((o) => o.letter).join('/')}）`)
          err.code = 'QUIZ_NOMAP'
          throw err
        }
        parsed = parsed2
        choice = choice2
      }
      if (!choice.badgeOnly && choice.text.replace(/[^\p{L}\p{N}]/gu, '').replace(/^[A-HＡ-Ｈ]$/, '').length === 0) {
        throw new Error(`选项 ${choice.letter} 的文字没有被 OCR 识别出来（只读到字母本身），无法做文字-坐标校验，已停止（未点击）`)
      }
      if (!inside(choice, { x: shot.window.x, y: shot.window.y, width: shot.window.width, height: shot.window.height })) {
        throw new Error('选项坐标落在窗口范围外，已停止（未点击）')
      }

      const clickRes = await runJSON(['clickpid', String(window.pid), String(Math.round(choice.clickX ?? choice.centerX)), String(Math.round(choice.clickY ?? choice.centerY)), '1', String(window.windowId), quiz.clickMode])
      log(`点击 ${choice.letter}. ${choice.text.slice(0, 30)} 徽标@(${Math.round(choice.clickX ?? choice.centerX)},${Math.round(choice.clickY ?? choice.centerY)}) [${clickRes.mechanism}]`)
      // 点击后立即截图校验：被点的选项徽标是否真的变高亮（选中）
      await verifySelection(window, choice, parsed)
      quiz.answered.push({ question: parsed.question.slice(0, 80), answer: `${choice.letter}. ${choice.text}` })
      quiz.perQuestionMs.push(Date.now() - roundStart)
      if (quiz.perQuestionMs.length > 200) quiz.perQuestionMs.splice(0, quiz.perQuestionMs.length - 200)
      if (pageIdx != null) quiz.answeredPages.add(pageIdx)
      if (lastQuestion) {
        finish(parsed.submit ? '最后一题已作答（按钮为「提交」），请人工提交' : '最后一题已作答（未找到「提交」按钮），请人工检查并提交')
        return
      }
      if (quiz.stop) break
      await runJSON(['clickpid', String(window.pid), String(parsed.next.centerX), String(parsed.next.centerY), '1', String(window.windowId), quiz.clickMode])
      log(`已答第 ${quiz.answered.length} 题，点击「下一题」`)
      if (roundYs) {
        const advanced = await waitAdvanceFast(window, roundYs, choice.clickY ?? choice.centerY, options.advanceTimeout ?? 2500)
        if (!advanced) log(`点击「下一题」后界面未变化（仍为第 ${pageIdx ?? '?'} 题），下一轮会重试`)
      } else {
        // 无蓝色徽标界面（例如网页测试页）没有廉价信号，只能短等，后面靠 waitStable 兜住动画
        await sleep(options.stepDelay ?? 300)
      }
    }
    if (quiz.stop) finish('已停止答题')
    else if (quiz.answered.length >= maxAnswers) finish(`达到最大题数 ${maxAnswers}（实际作答 ${quiz.answered.length} 题），已停止`)
    else finish(`连续 ${rounds} 轮没有作答成功（可能一直在翻已答页），已停止`)
  } catch (e) {
    quiz.error = e.message
    quiz.phase = 'error'
    quiz.running = false
    quiz.finishedAt = Date.now()
    log(`异常停止：${e.message}`)
  }
}

function finish(reason) {
  quiz.running = false
  quiz.stop = false
  quiz.phase = 'finished'
  quiz.finishedAt = Date.now()
  log(`结束：${reason}`)
}

// ── 工具外壳 ─────────────────────────────────────────────────────────────

function specToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters || {}),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    execute: options.execute,
  }
}

const present = (title) => (args) => ({ card: 'generic', title, kind: 'other', rawInput: args })

export function apply(ctx) {
  const tools = [
    defineTool({
      name: 'screen_permissions',
      description: '检查「屏幕共享答题助手」所需的两项 macOS 权限：屏幕录制、辅助功能。返回每项是否已开启以及需要打开的系统设置位置。首次使用前先调用。',
      parameters: {},
      presentCall: present('检查屏幕录制/辅助功能权限'),
      async execute() {
        const perms = await runJSON(['perms'])
        const missing = []
        if (!perms.screenCapture) missing.push('屏幕录制')
        if (!perms.accessibility) missing.push('辅助功能')
        return {
          ...perms,
          ok: missing.length === 0,
          missing,
          message: missing.length
            ? `缺少权限：${missing.join('、')}。请到 系统设置 → 隐私与安全性 → ${missing.join(' / ')} 中开启运行 DSH 的宿主进程（Terminal / iTerm / DeepSeek Harness），开启后可能需要重启宿主进程才生效。`
            : '屏幕录制与辅助功能权限均已开启。',
        }
      },
    }),

    defineTool({
      name: 'window_find',
      description: '查找「屏幕共享」窗口：标题**精确等于**该关键词，或者窗口所属应用本身就叫「屏幕共享」（这类真实共享窗口常常没有标题）。应用本身同名时优先级最高。返回窗口 ID、pid、屏幕逻辑坐标与 sharing 标记。',
      parameters: {
        keyword: { type: 'string', description: '窗口标题关键词，默认「屏幕共享」' },
      },
      presentCall: present('查找窗口'),
      async execute(args) {
        const keyword = (args.keyword || '屏幕共享').trim()
        const { window, hits, windows, near } = await findWindow(keyword)
        return {
          keyword,
          found: Boolean(window),
          window,
          candidates: hits.map((w) => ({ windowId: w.windowId, owner: w.owner, title: w.title, sharing: w.sharing, x: w.x, y: w.y, width: w.width, height: w.height })),
          near: near.map((w) => ({ windowId: w.windowId, owner: w.owner, title: w.title })),
          totalWindows: windows.length,
        }
      },
    }),

    defineTool({
      name: 'screen_capture',
      description: '截取指定窗口（默认自动查找标题精确为「屏幕共享」的窗口）为 PNG，返回图片路径、窗口逻辑坐标和截图像素尺寸/缩放比。截图文件是物理像素，工具返回的坐标全部是逻辑 point。',
      parameters: {
        windowId: { type: 'integer', description: '可选：窗口 ID（先用 window_find 获取）；省略则按关键词自动查找' },
        keyword: { type: 'string', description: '自动查找时的标题关键词，默认「屏幕共享」' },
      },
      presentCall: present('窗口截图'),
      async execute(args) {
        let win = null
        if (args.windowId) {
          win = windowById(await listWindows(), Number(args.windowId))
          if (!win) throw new Error(`窗口 ${args.windowId} 不存在或不可见`)
        } else {
          const found = await findWindow(args.keyword || '屏幕共享')
          win = found.window
          if (!win) throw new Error(`找不到标题精确为「${args.keyword || '屏幕共享'}」的窗口`)
        }
        const shot = await captureWindow(win)
        const ocr = await ocrShot(shot)
        return {
          ...shot,
          pixelWidth: ocr.pixelWidth,
          pixelHeight: ocr.pixelHeight,
          scaleX: ocr.scaleX,
          scaleY: ocr.scaleY,
          note: '点击请用 window 中的逻辑坐标；截图 PNG 是逻辑尺寸 × scale 的物理像素。',
        }
      },
    }),

    defineTool({
      name: 'screen_ocr',
      description: '用 Apple Vision 识别截图文字，返回每行文本、置信度和逻辑坐标（bbox 左上角 + 中心点 centerX/centerY，全局屏幕 point）。不传 pngPath 时自动截图后识别。',
      parameters: {
        pngPath: { type: 'string', description: '可选：屏幕截图的绝对路径（screen_capture 返回的 pngPath）；省略则现场截图' },
        windowId: { type: 'integer', description: '可选：配合自动截图使用的窗口 ID' },
        keyword: { type: 'string', description: '自动查找窗口时的标题关键词，默认「屏幕共享」' },
      },
      presentCall: present('OCR 识别截图'),
      async execute(args) {
        let shot
        if (args.pngPath) {
          if (!fs.existsSync(args.pngPath)) throw new Error(`截图不存在: ${args.pngPath}`)
          let win = null
          if (args.windowId) win = windowById(await listWindows(), Number(args.windowId))
          if (!win) {
            const found = await findWindow(args.keyword || '屏幕共享')
            win = found.window
          }
          if (!win) throw new Error('识别截图需要对应窗口的坐标信息，请传 windowId 或保证「屏幕共享」窗口开着')
          shot = { pngPath: args.pngPath, windowId: win.windowId, window: { x: win.x, y: win.y, width: win.width, height: win.height } }
        } else {
          let win = null
          if (args.windowId) win = windowById(await listWindows(), Number(args.windowId))
          else win = (await findWindow(args.keyword || '屏幕共享')).window
          if (!win) throw new Error(`找不到标题精确为「${args.keyword || '屏幕共享'}」的窗口`)
          shot = await captureWindow(win)
        }
        const ocr = await ocrShot(shot)
        return {
          ...shot,
          pixelWidth: ocr.pixelWidth,
          pixelHeight: ocr.pixelHeight,
          scaleX: ocr.scaleX,
          scaleY: ocr.scaleY,
          lines: ocr.lines,
        }
      },
    }),

    defineTool({
      name: 'mouse_click_inject',
      description: '用 CoreGraphics 把鼠标左键点击事件注入到目标进程（CGEvent.postToPid），不移动系统光标、不抢焦点，用户可同时继续操作鼠标。默认注入到「屏幕共享」窗口所属进程。',
      parameters: {
        x: { type: 'number', description: '逻辑坐标 X', required: true },
        y: { type: 'number', description: '逻辑坐标 Y', required: true },
        pid: { type: 'integer', description: '可选：目标进程 pid；省略则用「屏幕共享」窗口所属进程' },
        windowId: { type: 'integer', description: '可选：目标窗口 ID，注入事件时带上更有助于命中；省略则用上次 window_find 的窗口' },
        mode: { type: 'string', description: 'pointer = 真实光标点击后立刻还原位置（推荐，兼容性最好）；pid = 只发 CGEvent.postToPid（不碰光标，很多 App 会忽略）；auto = Chromium 自动退回 pointer' },
        count: { type: 'integer', description: '点击次数，默认 1，最大 3' },
      },
      presentCall: present('注入鼠标点击'),
      async execute(args) {
        const perms = await runJSON(['perms'])
        if (!perms.accessibility) throw new Error('辅助功能权限未开启，无法发送鼠标事件。请到 系统设置 → 隐私与安全性 → 辅助功能 为宿主进程开启后重启。')
        const x = Number(args.x)
        const y = Number(args.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('坐标非法')
        let pid = Number(args.pid) || quiz.windowPid || 0
        let windowId = Number(args.windowId) || quiz.windowId || 0
        if (!pid || !windowId) {
          const found = await findWindow('屏幕共享')
          if (!found.window) throw new Error('没有指定 pid/windowId，且找不到标题为「屏幕共享」的窗口')
          pid = pid || found.window.pid
          windowId = windowId || found.window.windowId
        }
        const mode = ['pointer', 'pid', 'auto'].includes(args.mode) ? args.mode : 'auto'
        return runJSON(['clickpid', String(pid), String(x), String(y), String(args.count || 1), String(windowId), mode])
      },
    }),

    defineTool({
      name: 'mouse_move',
      description: '把鼠标移动到指定逻辑坐标（全局屏幕 point）。',
      parameters: {
        x: { type: 'number', description: '逻辑坐标 X', required: true },
        y: { type: 'number', description: '逻辑坐标 Y', required: true },
      },
      presentCall: present('移动鼠标'),
      async execute(args) {
        const perms = await runJSON(['perms'])
        if (!perms.accessibility) throw new Error('辅助功能权限未开启，无法移动鼠标。')
        return runJSON(['move', String(Number(args.x)), String(Number(args.y))])
      },
    }),

    defineTool({
      name: 'quiz_start',
      description: '开始答题（用户说「开始答题」时调用）。定位「屏幕共享」窗口，循环：截图→OCR→模型选择答案→文字坐标校验→点击选项→点击「下一题」，直到最后一题或异常停止。后台运行，用 quiz_status 查看进度，quiz_stop 停止。',
      parameters: {
        keyword: { type: 'string', description: '窗口标题关键词，默认「屏幕共享」' },
        maxQuestions: { type: 'integer', description: '最多自动作答几题，默认 60' },
        clickMode: { type: 'string', description: '点击方式：pointer=真实光标点击后立刻还原位置（默认，兼容性最好）；pid=只注入到目标进程不碰光标；auto=自动判断', default: 'pointer' },
        questionTimeoutMs: { type: 'integer', description: '思考熔断阈值（毫秒）：单题模型超过该时间未给出答案就跳过该题进入下一题，默认 15000' },
      },
      presentCall: present('开始答题'),
      async execute(args) {
        if (quiz.running) return { started: false, message: '答题循环已在运行', status: statusSnapshot() }
        const perms = await runJSON(['perms'])
        if (!perms.screenCapture || !perms.accessibility) {
          return {
            started: false,
            missing: [...(!perms.screenCapture ? ['屏幕录制'] : []), ...(!perms.accessibility ? ['辅助功能'] : [])],
            message: '权限不足，未启动。请在 系统设置 → 隐私与安全性 中为宿主进程开启所需权限后重启宿主进程。',
          }
        }
        const keyword = (args.keyword || '屏幕共享').trim()
        const pre = await findWindow(keyword)
        if (!pre.window) {
          const hint = pre.near.length
            ? `当前只有相近的窗口：${pre.near.map((w) => `${w.owner}«${w.title}»`).join('、')}（标题必须精确等于「${keyword}」才会使用）`
            : '当前没有任何标题包含该关键词的窗口'
          return {
            started: false,
            error: `未找到标题精确为「${keyword}」的窗口。${hint}。请先打开屏幕共享窗口再开始答题。`,
          }
        }
        quiz.running = true
        quiz.stop = false
        quiz.phase = 'running'
        quiz.error = null
        quiz.log = []
        quiz.answered = []
        quiz.attempts = new Map()
        quiz.last = null
        quiz.startedAt = Date.now()
        log(`启动，关键词「${args.keyword || '屏幕共享'}」`)
        runQuiz(ctx, { keyword: args.keyword, maxQuestions: args.maxQuestions, clickMode: args.clickMode, questionTimeoutMs: args.questionTimeoutMs })
        await sleep(1200)
        return { started: true, message: '答题循环已启动', status: statusSnapshot() }
      },
    }),

    defineTool({
      name: 'quiz_stop',
      description: '停止答题（用户说「停止答题」时调用）。当前题处理完后退出循环，不再点击。',
      parameters: {},
      presentCall: present('停止答题'),
      async execute() {
        if (!quiz.running) return { running: false, message: '当前没有在跑答题循环' }
        quiz.stop = true
        quiz.phase = 'stopping'
        log('收到停止请求')
        return { stopping: true, message: '已请求停止，当前题处理完后退出' }
      },
    }),

    defineTool({
      name: 'quiz_status',
      description: '查看答题循环状态：是否在跑、已答题目、最近一次识别到的题目与选项、日志尾部、错误信息。',
      parameters: {},
      presentCall: present('答题进度'),
      async execute() {
        return statusSnapshot()
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)

  function statusSnapshot() {
    return {
      running: quiz.running,
      phase: quiz.phase,
      windowId: quiz.windowId,
      answeredCount: quiz.answered.length,
      answered: quiz.answered.slice(-20),
      fuseCount: quiz.fuseCount || 0,
      avgMsPerQuestion: quiz.perQuestionMs.length
        ? Math.round(quiz.perQuestionMs.reduce((a, b) => a + b, 0) / quiz.perQuestionMs.length)
        : null,
      lastQuestion: quiz.last,
      error: quiz.error,
      log: quiz.log.slice(-20),
      startedAt: quiz.startedAt ? new Date(quiz.startedAt).toISOString() : null,
      finishedAt: quiz.finishedAt ? new Date(quiz.finishedAt).toISOString() : null,
    }
  }

  ctx.effect(() => () => {
    quiz.stop = true
    quiz.running = false
  })

  log('插件已加载，原生辅助程序就绪')
}

export { parseQuiz }
