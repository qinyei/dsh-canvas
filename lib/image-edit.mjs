#!/usr/bin/env node
// image-edit.mjs —— 「出图 / 改图」双模脚本（provider 适配层）
//
// ⚠️ 本文件是随 dsh-canvas 分发的**打包副本**：相比 ~/.dsh/image-edit.mjs 做了两处可移植化——
//    · 默认产物目录不再写死 D:\dsh-media\images（改 ~/.dsh/plugin-data/dsh-canvas/images，可用 DSH_IMAGE_DIR 覆盖）
//    · gen 模式会去找**同目录**的 gen-image.mjs（用户自己 ~/.dsh 那份仍优先）
//
// 用法：
//   node ~/.dsh/image-edit.mjs edit <图片路径或URL> "<修改指令>" [--provider dashscope|modelscope] [--model x] [--out 目录] [--watch]
//   node ~/.dsh/image-edit.mjs gen  "<提示词>" [--model cogview-3-flash] [--size 1024x1024] [--out 目录]
//   node ~/.dsh/image-edit.mjs providers          # 自检：哪家钥匙在、端点通不通
//   node ~/.dsh/image-edit.mjs task <task_id>     # 取魔搭异步任务的结果（可反复取；查询不扣魔粒）
//
// provider 对照（2026-10-02 实测）：
//   dashscope  阿里百炼  qwen-image-edit          → 同步返回，17~18 秒/张，按张计费        ⭐ 快枪手
//   modelscope 魔搭      Qwen/Qwen-Image-Edit-2509 → 异步 task_id，排队几分钟，免费（1 魔粒/次）⭐ 免费量产
//   ⚠️ 魔搭**必须用 2509**！基础版 `Qwen/Qwen-Image-Edit` 会**整张重画**（不保真）。
//   ⚠️ 魔搭**只有「提交」扣魔粒，查询（task）不扣** → 拿到 task_id 随便取、别重复提交。
import fs from 'node:fs'
import path from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// 默认产物目录：DSH_IMAGE_DIR 可覆盖；默认落在画布自己的产物目录（跨平台可用）
const IMAGE_DIR = process.env.DSH_IMAGE_DIR || path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-canvas', 'images')
const DS_BASE = 'https://dashscope.aliyuncs.com'
const MS_BASE = 'https://api-inference.modelscope.cn/v1'
const DEFAULT_MODEL = { dashscope: 'qwen-image-edit', modelscope: 'Qwen/Qwen-Image-Edit-2509' }

// ---------- 钥匙：环境变量 → （回退）用户级注册表。绝不回显、绝不落盘 ----------
function fromRegistry(name) {
  try {
    return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}','User')"`, {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch { return '' }
}
function rawKey(name) {
  let v = (process.env[name] ?? '').trim() || fromRegistry(name)
  // 兼容历史事故：阿里百炼的钥匙曾被误放进 MODELSCOPE_API_KEY
  if (!v && name === 'DASHSCOPE_API_KEY') v = (process.env.MODELSCOPE_API_KEY ?? '').trim() || fromRegistry('MODELSCOPE_API_KEY')
  return v
}
const dsKey = () => rawKey('DASHSCOPE_API_KEY').replace(/^ms-/, '')  // 曾误粘 ms- 前缀
const msKey = () => rawKey('MODELSCOPE_API_KEY')                     // 魔搭的就是 ms- 开头

// ---------- 小工具 ----------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}
/** 取**所有**同名参数（`--ref a --ref b`）—— 多图输入用。 */
function argAll(name) {
  const out = []
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === '--' + name && process.argv[i + 1]) out.push(process.argv[i + 1])
  }
  return out
}
const hasFlag = (name) => process.argv.includes('--' + name)
function dataUrl(file) {
  const buf = fs.readFileSync(file)
  const ext = path.extname(file).toLowerCase().replace('.jpg', '.jpeg').slice(1) || 'png'
  return { url: `data:image/${ext};base64,${buf.toString('base64')}`, ext }
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
async function save(url, outDir, prefix) {
  const b = Buffer.from(await (await fetch(url)).arrayBuffer())
  fs.mkdirSync(outDir, { recursive: true })
  const p = path.join(outDir, `${prefix}-${stamp()}.png`)
  fs.writeFileSync(p, b)
  console.log(`✔ 已存: ${p} (${(b.length / 1024).toFixed(0)} KB)`)
  return p
}

/**
 * 打一行**机器可读**的元信息（画布图像节点靠它显示「模型 · 耗时 · 花费」）。
 * 格式固定为：`META {json}`（单独一行）——子代理把它整行抄进 .result 文件即可。
 * ⚠️ 花费是**估算**（百炼按张计费，实际以账单为准；魔搭按魔粒 1/次）。
 */
function printMeta(info) {
  console.log('META ' + JSON.stringify(info))
}

// ---------- 改图：① 阿里百炼（同步）----------
// images: 第 1 张 = 要改的图，后面的是**参考图**（角色 / 风格）—— 多图输入靠这个
async function editDashScope(images, prompt, model, outDir) {
  const key = dsKey()
  if (!key) throw new Error('缺 DASHSCOPE_API_KEY（阿里百炼的 key）')
  const t0 = Date.now()
  console.log(`▶ provider=阿里百炼  model=${model}（同步；${images.length} 张输入图）`)
  const r = await fetch(`${DS_BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          { role: 'user', content: [...images.map((img) => ({ image: img })), { text: prompt }] },
        ],
      },
      parameters: { negative_prompt: '', watermark: false, n: 1 },
    }),
  })
  const text = await r.text()
  if (r.status !== 200) throw new Error(`HTTP ${r.status}\n${text.slice(0, 800)}`)
  const j = JSON.parse(text)
  const url = (j?.output?.choices?.[0]?.message?.content ?? []).find((c) => c.image)?.image
  if (!url) throw new Error('响应里没有图片：' + text.slice(0, 600))
  console.log(`✔ 出图（${((Date.now() - t0) / 1000).toFixed(1)}s，${j.usage?.width}x${j.usage?.height}）`)
  const saved = await save(url, outDir, 'edit')
  printMeta({
    provider: 'dashscope',
    model,
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    size: `${j.usage?.width ?? '?'}x${j.usage?.height ?? '?'}`,
    images: images.length,
    path: saved,
    cost: { unit: '元', value: 0.04, estimated: true },
  })
  return saved
}

// ---------- 改图：② 魔搭（异步；查询不扣魔粒）----------
async function msSubmit(image, prompt, model) {
  const key = msKey()
  if (!key) throw new Error('缺 MODELSCOPE_API_KEY（魔搭的 token）')
  const r = await fetch(`${MS_BASE}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-ModelScope-Async-Mode': 'true' },
    body: JSON.stringify({ model, prompt, image_url: [image], size: '1024x1024' }),
  })
  const t = await r.text()
  const j = (() => { try { return JSON.parse(t) } catch { return null } })()
  if (r.status !== 200 || !j?.task_id) throw new Error(`HTTP ${r.status}\n${t.slice(0, 600)}`)
  return j.task_id
}
async function msFetch(taskId, outDir, deadlineSec = 90) {
  const key = msKey()
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < deadlineSec) {
    const r = await fetch(`${MS_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}`, 'X-ModelScope-Task-Type': 'image_generation' },
    })
    const o = await r.json()
    const s = o?.task_status ?? o?.status
    if (s === 'SUCCEED') {
      const urls = o.output_images ?? []
      if (!urls.length) throw new Error('SUCCEED 但没有图片：' + JSON.stringify(o).slice(0, 400))
      const waited = Number(((Date.now() - t0) / 1000).toFixed(0))
      console.log(`✔ 出图（排队 ${waited}s）`)
      const saved = []
      for (const u of urls) saved.push(await save(u, outDir, 'edit-ms'))
      if (saved[0]) {
        printMeta({
          provider: 'modelscope',
          model: 'Qwen/Qwen-Image-Edit-2509',
          seconds: waited,
          path: saved[0],
          cost: { unit: '魔粒', value: 1, estimated: false },
        })
      }
      return saved[0] ?? true
    }
    if (s === 'FAILED') throw new Error('任务失败：' + JSON.stringify(o).slice(0, 500))
    await new Promise((rr) => setTimeout(rr, 5000))
  }
  console.log(`⏳ 排队中（已等 ${deadlineSec}s）—— 不扣魔粒，回头再取：`)
  console.log(`   node ~/.dsh/image-edit.mjs task ${taskId}`)
  return false
}
async function editModelScope(image, prompt, model, outDir, watch) {
  const taskId = await msSubmit(image, prompt, model)
  console.log(`▶ provider=魔搭  model=${model}（异步）`)
  console.log(`▶ task_id = ${taskId}`)
  if (!watch) {
    console.log('▶ 已提交（提交才扣 1 魔粒）。取图命令（查询不扣魔粒，可反复取）：')
    console.log(`   node ~/.dsh/image-edit.mjs task ${taskId}`)
    return taskId
  }
  return msFetch(taskId, outDir, 90)
}

// ---------- 出图：智谱（复用现成脚本；用 execFileSync 免掉 shell 转义坑）----------
function gen(prompt, model, size, outDir) {
  // 优先用用户自己那份 ~/.dsh/gen-image.mjs，没有就用随本包分发的同目录副本
  const script = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'gen-image.mjs'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'gen-image.mjs'),
  ].find((p) => p && fs.existsSync(p))
  if (!script) throw new Error('找不到 gen-image.mjs（~/.dsh 下没有，包内也没有）')
  console.log(`▶ provider=智谱  model=${model}`)
  const t0 = Date.now()
  const out = execFileSync(process.execPath, [script, prompt, '--model', model, '--size', size, '--out', outDir], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], timeout: 300000,
  }).trim()
  console.log(out)
  const hit = out.match(/OK:\s*(.+?)\s*$/m) // gen-image.mjs 会打印 `OK: <路径>`
  printMeta({
    provider: 'zhipu',
    model,
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    size,
    path: hit ? hit[1].trim() : null,
    cost: { unit: '元', value: 0, note: '免费额度' },
  })
}

// ---------- 自检 ----------
async function providers() {
  const ds = dsKey(), ms = msKey()
  console.log(`钥匙：DASHSCOPE_API_KEY ${ds ? `有（${ds.length} 字符，${ds.slice(0, 6)}…）` : '缺'} / MODELSCOPE_API_KEY ${ms ? `有（${ms.length} 字符，${ms.slice(0, 3)}…）` : '缺'}`)
  if (ds) {
    const r = await fetch(`${DS_BASE}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ds}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-turbo', messages: [{ role: 'user', content: 'ping' }], max_tokens: 3 }),
    })
    console.log(`百炼（改图主力）：HTTP ${r.status} ${r.status === 200 ? '✅' : '❌ ' + (await r.text()).slice(0, 160)}`)
  }
  if (ms) {
    const r = await fetch(`${MS_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ms}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'ZhipuAI/GLM-4.7-Flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 3 }),
    })
    console.log(`魔搭（免费备胎）：HTTP ${r.status} ${r.status === 200 ? '✅' : '❌ ' + (await r.text()).slice(0, 160)}`)
  }
  console.log('提示：`GET /v1/models` 不校验钥匙，别拿它当自检；魔搭只有「提交」扣魔粒，「task 查询」不扣。')
}

// ---------- 入口 ----------
const mode = process.argv[2]
const outDir = arg('out', IMAGE_DIR)
try {
  const src = process.argv[3]
  const prompt = process.argv[4]
  const provider = arg('provider', 'dashscope')
  // 指令也可以写在文件里（画布图像节点用这个：免掉引号/换行在 shell 里的转义地狱）
  const promptFile = arg('prompt-file', '')
  const promptFromFile = promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8').trim() : ''
  const effectivePrompt = promptFromFile || prompt
  if (mode === 'edit') {
    if (!src || !effectivePrompt) throw new Error('用法: edit <图片> "<指令>"（或 --prompt-file <文件>）[--provider dashscope|modelscope] [--model x] [--out 目录] [--watch]')
    const model = arg('model', DEFAULT_MODEL[provider])
    if (!DEFAULT_MODEL[provider]) throw new Error(`未知 provider: ${provider}（可选 dashscope / modelscope）`)
    const image = /^https?:\/\//.test(src) ? src : dataUrl(src).url
    // --ref <图片> 可重复：多图输入（角色参考 / 风格参考），第 1 张永远是"要改的那张"
    const refs = argAll('ref').map((r) => (/^https?:\/\//.test(r) ? r : dataUrl(r).url))
    const images = [image, ...refs]
    if (provider === 'dashscope') await editDashScope(images, effectivePrompt, model, outDir)
    else await editModelScope(image, effectivePrompt, model, outDir, hasFlag('watch'))
  } else if (mode === 'gen') gen(effectivePrompt, arg('model', 'cogview-3-flash'), arg('size', '1024x1024'), outDir)
  else if (mode === 'task') {
    if (!src) throw new Error('用法: task <task_id>')
    await msFetch(src, outDir, Number(arg('max', 60)))
  } else if (mode === 'providers') await providers()
  else {
    console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 19).join('\n'))
    process.exitCode = 2
  }
  process.exitCode ??= 0   // 不用 process.exit()：fetch 句柄未关就强退，Node 会在 Windows 上吐 libuv 断言
} catch (e) {
  console.log('✖ ' + e.message)   // 用 stdout：PowerShell 会把 stderr 渲染成红字错误记录
  process.exitCode = 1
}
