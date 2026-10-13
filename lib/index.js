/**
 * dsh-canvas — Host 半边：把「画布图（graph JSON）」编译成内核 workflow 脚本并执行。
 *
 * ## 设计（画布只是外壳，引擎已经有了）
 *   graph JSON ──compile()──▶ workflow 脚本(JS 字符串) ──▶ ctx.workflowEngine.start()
 *   内核 workflow 事件（workflow/start|phase|log|agent-start|agent-end|end）──▶ SSE ──▶ 画布节点高亮
 *
 * ## 依赖纪律（实测定下来的两条）
 *
 * 1. **数组式 `ctx.inject([...])` 只要有一个服务不可用，回调根本不执行且静默。**
 *    （0.1.2 移除 `apiProxy` 就是这么让 `dsh-offpeak` 整个失效的。）
 * 2. **`workflowEngine` 是惰性激活的**：实测 `ctx.get('workflowEngine')` 在本插件里返回
 *    `undefined`，但服务本身是活的（内核自带的 `workflow` 工具能正常跑脚本）。
 *    差异在于 **`inject` 声明依赖会等它就绪，`ctx.get` 不会**。
 *    → 所以这里用**两层 inject**：
 *      · 第一层只依赖 `webServer` → 基础路由（probe/compile/存盘）永远挂得上；
 *      · 第二层多依赖 `workflowEngine` → 引擎一就绪才挂 run/stop/events + 事件订阅。
 *    好处：引擎万一缺席，插件也只是降级（probe 照常能自检），而不是整块静默失效。
 *
 * @module dsh-canvas
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GENERATE_SYSTEM, buildGenerateScript, extractGraph, normalizeGraph } from './generate.js';

export const name = 'dsh-canvas';

/** 只硬依赖 webServer；引擎走第二层 inject（见文件头）。 */
export const inject = ['webServer'];

/** 路由前缀。 */
const BASE = '/api/dsh-canvas';
/** 免鉴权探针别名（排障/curl/手机用，和 /dsh-go 同风格）。 */
const PROBE_ALIAS = '/dsh-canvas/probe';
/** 事件保留条数（刷页面后能补看最近发生了什么）。 */
const RECENT_MAX = 300;

const DATA_DIR = path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-canvas');
const GRAPH_DIR = path.join(DATA_DIR, 'graphs');

/**
 * `/asset` 允许读取的图片根目录（**白名单**）。
 * 为什么需要：画布要把生成出来的图贴成缩略图，但浏览器加载不了本地绝对路径，
 * 所以由 host 代读。**必须白名单**——否则一条免鉴权路由就成了"任意文件读取"。
 * 可用环境变量 `DSH_CANVAS_ASSET_ROOTS` 覆盖（多个用 path.delimiter 分隔）。
 */
const ASSET_ROOTS = (process.env.DSH_CANVAS_ASSET_ROOTS
  ? String(process.env.DSH_CANVAS_ASSET_ROOTS).split(path.delimiter)
  : [
      // 画布图像节点的**默认产物目录**（不放进来缩略图会被 403 挡掉 —— 2026-10-02 实测踩过）
      path.join(DATA_DIR, 'images'),
      path.join('D:', 'dsh-media', 'images'),
      path.join('D:', 'dsh-media', 'edits'),
      path.join('D:', 'dsh-work', 'qwen-image-edit', 'out'),
    ])
  .map((p) => p.trim())
  .filter(Boolean);
/** 允许的图片扩展名 → content-type。 */
const ASSET_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * 清理一个目录里「太久没动过」的图片。**安全约束**：
 *   · 只删这个目录**本层**的文件（不递归、不跟符号链接）
 *   · 只删图片扩展名
 *   · 有 1 小时硬性保护垫：再短的 TTL 也不会删刚生成的
 *   · 目录不存在 → 当空目录（不抛错）
 * @exported 供离线断言用（传临时目录就能安全测试）
 * @returns {{deleted: number, bytes: number, errors: string[]}}
 */
export function cleanupOldImages(dir, ttlMs, opts = {}) {
  const exts = opts.exts ?? ASSET_EXT;
  const now = opts.now ?? Date.now();
  const floorMs = opts.floorMs ?? 60 * 60 * 1000;
  const out = { deleted: 0, bytes: 0, errors: [] };
  let list = [];
  try {
    list = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of list) {
    const ext = path.extname(name).toLowerCase();
    if (!exts[ext]) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const age = now - st.mtimeMs;
    if (age < ttlMs || age < floorMs) continue;
    try {
      fs.unlinkSync(full);
      out.deleted += 1;
      out.bytes += st.size;
    } catch (err) {
      out.errors.push(`${name}: ${err?.message ?? err}`);
    }
  }
  return out;
}

/**
 * 清理画布自己在临时目录里留下的「指令文件 / 产物回传文件」（`canvas-img-*`）。
 * 这些文件只服务于一次运行，留久了纯属垃圾。
 */
export function cleanupCanvasTmp(ttlMs, opts = {}) {
  const dir = opts.dir ?? os.tmpdir();
  const now = opts.now ?? Date.now();
  const out = { deleted: 0, bytes: 0, errors: [] };
  let list = [];
  try {
    list = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of list) {
    if (!/^canvas-img-.+\.(txt|result)$/i.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile() || now - st.mtimeMs < ttlMs) continue;
    try {
      fs.unlinkSync(full);
      out.deleted += 1;
      out.bytes += st.size;
    } catch (err) {
      out.errors.push(`${name}: ${err?.message ?? err}`);
    }
  }
  return out;
}

/** 产物保留天数（`DSH_CANVAS_IMAGE_TTL_DAYS`，默认 7；设 0 关闭自动清理）。 */
const IMAGE_TTL_DAYS = (() => {
  const raw = Number(process.env.DSH_CANVAS_IMAGE_TTL_DAYS);
  return Number.isFinite(raw) ? raw : 7;
})();

/**
 * 校验一个路径能不能通过 `/asset`（读图）或 `/reveal`（在资源管理器里定位）访问。
 * 规则：必须在白名单目录内（realpath 解析后再比，防符号链接穿越）+ 必须是允许的图片扩展名 + 必须存在。
 * ⚠️ 两处必须共用这一份判定，不然迟早一边严一边松。
 * @returns {{ok:true, path:string, type:string} | {ok:false, status:number, error:string}}
 */
export function checkAssetPath(raw) {
  const abs = path.resolve(String(raw ?? ''));
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    /* 文件不存在/没权限 → 用字面路径继续比对，交给下面统一报错 */
  }
  const inside = ASSET_ROOTS.some((root) => {
    let r = path.resolve(root);
    try {
      r = fs.realpathSync(r);
    } catch {
      /* 白名单目录不存在时用字面路径兜底 */
    }
    return real === r || real.startsWith(r + path.sep);
  });
  if (!inside) {
    return { ok: false, status: 403, error: '该路径不在白名单里（只允许读画布配置的图片目录）' };
  }
  const type = ASSET_EXT[path.extname(real).toLowerCase()];
  if (!type) {
    return { ok: false, status: 415, error: '不支持的图片类型（只允许 png/jpg/jpeg/webp/gif）' };
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, status: 404, error: '文件不存在' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, error: '不是一个文件' };
  return { ok: true, path: real, type };
}

/** 活跃运行：runId → { run, sessionId, nodeIds, startedAt }。 */
const runs = new Map();
/** 外部运行（对话模式，`POST /report` 建）：runId → { title, nodeIds, startedAt }。 */
const externalRuns = new Map();
/** SSE 订阅者：{ res, runId: string | null }。 */
const sseClients = new Set();
/** 最近事件环形缓冲（SSE 断线重连后补看）。 */
const recent = [];

// ─────────────────────────── 编译 ───────────────────────────

/** 编译/校验期错误（前端据此把节点标红）。 */
export class CanvasError extends Error {
  constructor(message, code = 'CANVAS_COMPILE') {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
  }
}

/** 支持的节点类型。 */
const NODE_TYPES = new Set(['trigger', 'agent', 'code', 'condition', 'parallel', 'approval', 'image', 'output']);
/**
 * 「只输出结果」的硬约束。
 * 提示词里写「用一句话」是软约束 —— 模型（尤其带人设时）经常额外附上解释、
 * 字数统计或自我评价。所以默认在提示词末尾再压一句，节点可用 data.terse = false 关掉。
 */
const TERSE_SUFFIX =
  '\n\n【输出要求】只输出要求的内容本身：不要开场白、不要解释、不要字数统计、不要自我评价或邀功。';

/** `{{nodeId}}` / `{{step_nodeId}}` 变量引用。 */
const VAR_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** 把任意 id 变成合法 JS 标识符片段。 */
function safeIdent(raw, fallback) {
  const cleaned = String(raw ?? '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  const out = cleaned || fallback;
  return /^[0-9]/.test(out) ? `n_${out}` : out;
}

/** 节点 id → 脚本里的变量名。 */
export function varName(nodeId) {
  return `step_${safeIdent(nodeId, 'node')}`;
}

/** 任意名字 → meta.name 要的 kebab-case。 */
function kebab(raw, fallback) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

/**
 * 把画布图编译成内核 workflow 脚本。
 * @param graph 画布图 JSON（nodes + edges）
 * @returns {{ script: string, meta: object, order: string[], warnings: string[], nodesById: object }}
 * @throws {CanvasError} 图结构非法（空图 / 重复 id / 未知类型 / 悬空边 / 有环 / 引用不存在的上游）
 */
/**
 * 把画布按「审批节点」切成两段，各自编译成独立脚本。
 *
 * 为什么这么切：内核 workflow 脚本**没有暂停机制**（见文件头/交接书探路结论），
 * 所以「跑到审批点停下来等人」只能靠**段间停下来** —— 段与段之间没有 worker 存在，
 * 等待零成本、也不受任何超时约束。
 *
 * 实现上刻意**改造出子图再交给既有 compile()**，而不是另写一套生成器：
 * agent / code / condition / parallel / 重试 / terse 等行为自动继承，不会两边走偏。
 *
 * @param graph 完整画布图
 * @param approvalId 审批节点的 id（P3 一次只支持一个）
 * @returns {{ pre: object, post: object, approval: object }}
 *   pre/post 都是 compile() 的返回值；approval 是审批节点的信息（note 等）
 */
export function compileSplit(graph, approvalId) {
  const g = graph && typeof graph === 'object' ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const approval = byId.get(approvalId);
  if (!approval || approval.type !== 'approval') {
    throw new CanvasError(`compileSplit: ${approvalId} 不是一个审批节点`);
  }

  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (outgoing.has(e.from) && incoming.has(e.to)) {
      outgoing.get(e.from).push(e.to);
      incoming.get(e.to).push(e.from);
    }
  }

  /** 泛洪收集（direction = 'up' 走 incoming，'down' 走 outgoing）。 */
  const flood = (startIds, direction) => {
    const seen = new Set();
    const stack = [...startIds];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur) || !byId.has(cur)) continue;
      seen.add(cur);
      const next = direction === 'up' ? incoming.get(cur) : outgoing.get(cur);
      for (const nb of next) stack.push(nb);
    }
    return seen;
  };

  const ancestors = flood(incoming.get(approvalId) ?? [], 'up');
  const descendants = flood(outgoing.get(approvalId) ?? [], 'down');
  const directNext = (outgoing.get(approvalId) ?? []).filter((x) => byId.has(x));

  if (directNext.length === 0) {
    throw new CanvasError(`审批节点「${approvalId}」后面没有接任何节点：它得接上"通过之后要做什么"`);
  }
  if (ancestors.size === 0) {
    throw new CanvasError(`审批节点「${approvalId}」前面没有任何节点（连不到起点）`);
  }

  // ── 段 1：祖先节点 + 一个临时 output（交出审批点的数据上游） ──
  const preNodeIds = new Set(ancestors);
  const preNodes = nodes.filter((n) => preNodeIds.has(n.id));
  const preEdges = edges.filter((e) => preNodeIds.has(e.from) && preNodeIds.has(e.to));
  const preOutputId = '__approval_pre_out';
  // 审批点的直接上游：段 1 的返回值就取它们（没有就直接用所有没有后继的祖先）
  const approvalUps = (incoming.get(approvalId) ?? []).filter((x) => byId.has(x));
  const preTails = approvalUps.length > 0
    ? approvalUps
    : preNodes.filter((n) => (outgoing.get(n.id) ?? []).filter((x) => preNodeIds.has(x)).length === 0).map((n) => n.id);
  for (const tail of preTails) {
    preEdges.push({ id: `__e_pre_${tail}`, from: tail, to: preOutputId });
  }
  preNodes.push({ id: preOutputId, type: 'output', position: { x: 0, y: 0 }, data: {} });

  // ── 段 2：后代节点 + 一个临时 trigger（值 = args.checkpoint） ──
  const postNodeIds = new Set(descendants);
  const postNodes = nodes.filter((n) => postNodeIds.has(n.id));
  const postEdges = edges.filter((e) => postNodeIds.has(e.from) && postNodeIds.has(e.to));
  const postTriggerId = '__approval_post_in';
  postNodes.push({
    id: postTriggerId,
    type: 'trigger',
    position: { x: 0, y: 0 },
    data: { prompt: '' },  // 真实值来自 args.prompt（host 会把 checkpoint 放进 args）
  });
  for (const next of directNext) {
    if (postNodeIds.has(next)) {
      postEdges.push({ id: `__e_post_${next}`, from: postTriggerId, to: next });
    }
  }

  const pre = compile({
    version: 1,
    name: (typeof g.name === 'string' && g.name ? g.name : 'canvas') + '-part1',
    nodes: preNodes,
    edges: preEdges,
  });
  const post = compile({
    version: 1,
    name: (typeof g.name === 'string' && g.name ? g.name : 'canvas') + '-part2',
    nodes: postNodes,
    edges: postEdges,
  });

  const note = approval.data && typeof approval.data.note === 'string' ? approval.data.note.trim() : '';
  return {
    pre,
    post,
    approval: { id: approvalId, note: note === '' ? '这一段的产出要不要继续？' : note },
    counts: { ancestors: ancestors.size, descendants: descendants.size },
    imageTmp: { ...(pre.imageTmp ?? {}), ...(post.imageTmp ?? {}) },
  };
}

/**
 * 把画布按**多个审批节点**切成 N+1 段（P0-6：多层长链）。
 *
 * 与单门版 `compileSplit` 的关系：那个保持原样不动（行为零风险），这里是它的推广。
 * 段 i 的节点集合：
 *   · 第 0 段   = 第 1 个门的**所有祖先**（含原起点），出口接临时 output
 *   · 中间段 i  = `descendants(门_i) \ (descendants(门_{i+1}) ∪ {门_{i+1}})`（入口接临时 trigger、出口接临时 output）
 *   · 最后一段 = 最后一个门的**所有后代**（含原输出），入口接临时 trigger
 *
 * **硬约束：多个审批门必须串在同一条链上**（并行分支里的多个门无法"依次等人"，直接报错拒绝，
 * 免得跑出一个静默丢节点的鬼结果；链中间有分叉同样拒绝）。
 *
 * @returns {{ segments: object[], approvals: {id: string, note: string}[], order: string[], script: string }}
 */
export function compileSplits(graph, approvalIds) {
  const g = graph && typeof graph === 'object' ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const baseName = typeof g.name === 'string' && g.name ? g.name : 'canvas';

  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (outgoing.has(e.from) && incoming.has(e.to)) {
      outgoing.get(e.from).push(e.to);
      incoming.get(e.to).push(e.from);
    }
  }
  const flood = (startIds, direction) => {
    const seen = new Set();
    const stack = [...startIds];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur) || !byId.has(cur)) continue;
      seen.add(cur);
      const next = direction === 'up' ? incoming.get(cur) : outgoing.get(cur);
      for (const nb of next) stack.push(nb);
    }
    return seen;
  };

  // 拓扑序（用于给审批门排序）。
  // ⚠️ 不能直接 `compile(g)`：approval 节点由**结构层**处理，单独进 compile 会被拦下报
  //    「approval 不该走到单节点生成」。所以这里自己做一个 Kahn 排序 + 环检测。
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    order.push(cur);
    for (const nx of outgoing.get(cur) ?? []) {
      if (!indeg.has(nx)) continue;
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) queue.push(nx);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.map((n) => n.id).filter((id) => !order.includes(id));
    throw new CanvasError(`画布里有环（无法排序）：${stuck.join(' → ')}`);
  }
  const ids = [...new Set(Array.isArray(approvalIds) ? approvalIds : [])].filter(
    (x) => typeof x === 'string' && x !== '',
  );
  if (ids.length === 0) throw new CanvasError('compileSplits: 没有给审批节点');
  for (const id of ids) {
    const n = byId.get(id);
    if (!n || n.type !== 'approval') throw new CanvasError(`compileSplits: ${id} 不是一个审批节点`);
  }
  ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // 链式校验：每个门必须落在前一个门的后代里
  for (let i = 1; i < ids.length; i++) {
    const prevDesc = flood(outgoing.get(ids[i - 1]) ?? [], 'down');
    if (!prevDesc.has(ids[i])) {
      throw new CanvasError(
        `多个审批节点必须串在**同一条链**上：「${ids[i]}」不在「${ids[i - 1]}」的下游（并行分支里的多个审批门暂不支持）`,
      );
    }
  }

  const segments = [];
  const approvals = [];
  /** 图里**所有**审批门的 id（不止本次传入的那些）：它们都不进段。 */
  const allGateIds = nodes.filter((n) => n && n.type === 'approval').map((n) => n.id);
  // 段数 = 门数 + 1。段 i 的语义：门 i-1 **之后**、门 i **之前**（第一段/最后一段各少一侧）
  for (let i = 0; i < ids.length + 1; i++) {
    const gateBefore = i === 0 ? null : ids[i - 1];
    const gateAfter = i === ids.length ? null : ids[i];

    let set;
    if (gateBefore === null) {
      set = new Set(flood(incoming.get(gateAfter) ?? [], 'up'));
    } else if (gateAfter === null) {
      set = new Set(flood(outgoing.get(gateBefore) ?? [], 'down'));
    } else {
      const beforeDesc = flood(outgoing.get(gateBefore) ?? [], 'down');
      const afterDesc = flood(outgoing.get(gateAfter) ?? [], 'down');
      const afterAnc = flood(incoming.get(gateAfter) ?? [], 'up');
      set = new Set([...beforeDesc].filter((x) => x !== gateAfter && !afterDesc.has(x)));
      for (const x of set) {
        if (!afterAnc.has(x)) {
          throw new CanvasError(
            `审批门「${gateBefore}」与「${gateAfter}」之间有分叉节点（${x}）没走在主链上：多层长链暂不支持链中分叉，请把它挪出这条链`,
          );
        }
      }
    }
    // 审批门**本身不进段**（它是"段与段之间的停顿点"）。多门时更要剔除：例如
    // 「门1 → 图 → 门2」的第一段范围里其实夹着门1，必须把它摘掉，否则 compile 会报
    // 「approval 不该走到单节点生成」。
    for (const gid of allGateIds) set.delete(gid);

    if (set.size === 0) {
      throw new CanvasError(
        `第 ${i + 1} 段是空的：门「${gateBefore ?? '(起点)'}」与门「${gateAfter ?? '(终点)'}」之间没有任何节点`,
      );
    }

    const segNodes = nodes.filter((n) => set.has(n.id));
    const segEdges = edges.filter((e) => set.has(e.from) && set.has(e.to));
    const segCoveredIn = new Set(segEdges.map((e) => e.to));
    const segCoveredOut = new Set(segEdges.map((e) => e.from));

    // 入口：第一段自带原起点；其余段接一个临时 trigger（值来自 args.prompt），
    //       优先接「上一个门的直接后继」，拿不到就退化成段内没有入边的节点。
    if (gateBefore !== null) {
      const inId = `__seg${i}_in`;
      segNodes.push({ id: inId, type: 'trigger', position: { x: 0, y: 0 }, data: { prompt: '' } });
      const fromGate = (outgoing.get(gateBefore) ?? []).filter((x) => set.has(x));
      const heads0 = fromGate.length > 0 ? fromGate : [...set].filter((x) => !segCoveredIn.has(x));
      const heads = heads0.length > 0 ? heads0 : [...set];
      for (const h of heads) segEdges.push({ id: `__e_seg${i}_in_${h}`, from: inId, to: h });
    }

    // 出口：最后一段自带原输出；其余段接一个临时 output，
    //       优先接「下一个门的直接前驱」，拿不到就退化成段内没有出边的节点。
    if (gateAfter !== null) {
      const outId = `__seg${i}_out`;
      segNodes.push({ id: outId, type: 'output', position: { x: 0, y: 0 }, data: {} });
      const toGate = (incoming.get(gateAfter) ?? []).filter((x) => set.has(x));
      const tails0 = toGate.length > 0 ? toGate : [...set].filter((x) => !segCoveredOut.has(x));
      const tails = tails0.length > 0 ? tails0 : [...set];
      for (const t of tails) segEdges.push({ id: `__e_seg${i}_out_${t}`, from: t, to: outId });
    }

    segments.push(
      compile({
        version: 1,
        name: `${baseName}-part${i + 1}`,
        nodes: segNodes,
        edges: segEdges,
      }),
    );

    // 每个段之后（除最后一段）对应一次问人
    if (gateAfter !== null) {
      const rawNote = byId.get(gateAfter)?.data?.note;
      approvals.push({
        id: gateAfter,
        note: typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote.trim() : '这一段的产出要不要继续？',
      });
    }
  }

  const imageTmp = {};
  for (const seg of segments) Object.assign(imageTmp, seg.imageTmp ?? {});
  return { segments, approvals, order: segments[0].order, script: segments[0].script, imageTmp };
}

export function compile(graph) {
  const g = graph && typeof graph === 'object' ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];

  if (nodes.length === 0) throw new CanvasError('画布是空的：至少要有 trigger 和 output 两个节点');

  const byId = new Map();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || n.id === '') throw new CanvasError('有节点缺少 id');
    if (byId.has(n.id)) throw new CanvasError(`节点 id 重复：${n.id}`);
    if (!NODE_TYPES.has(n.type)) {
      throw new CanvasError(
        `不支持的节点类型：${String(n.type)}（可用：trigger / agent / code / condition / parallel / approval / image / output）`,
      );
    }
    byId.set(n.id, n);
  }

  // 变量名撞名检查：`a-b` 与 `a_b` 都会归一成 `step_a_b` → 生成两条同名 const → 语法错。
  // （独立审查实测：分享来的画布可构造）这里直接报错，比悄悄改名好定位。
  const seenVar = new Map();
  for (const n of nodes) {
    const v = varName(n.id);
    if (seenVar.has(v)) {
      throw new CanvasError(
        `节点 id「${n.id}」与「${seenVar.get(v)}」的变量名撞了（都归一成 ${v}）：请改用不会冲突的 id`,
      );
    }
    seenVar.set(v, n.id);
  }

  const triggers = nodes.filter((n) => n.type === 'trigger');
  const outputs = nodes.filter((n) => n.type === 'output');
  if (triggers.length !== 1) throw new CanvasError(`需要恰好 1 个 trigger 起始节点（现在有 ${triggers.length} 个）`);
  if (outputs.length < 1) throw new CanvasError('缺少 output 节点：结果要交给它返回');

  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') throw new CanvasError('有连线缺少 from / to');
    if (!byId.has(e.from) || !byId.has(e.to)) {
      throw new CanvasError(`连线指向不存在的节点：${e.from} → ${e.to}`);
    }
    if (e.from === e.to) throw new CanvasError(`节点自己连自己：${e.from}`);
    outgoing.get(e.from).push(e.to);
    incoming.get(e.to).push(e.from);
  }

  // 拓扑排序（Kahn）：有环 → 报错
  const indeg = new Map(nodes.map((n) => [n.id, incoming.get(n.id).length]));
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  const placed = new Set();
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    placed.add(id);
    for (const next of outgoing.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) ready.push(next);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !placed.has(n.id)).map((n) => n.id);
    throw new CanvasError(`画布里有环（无法排序）：${stuck.join(' → ')}`);
  }

  // 可达性：trigger 走不到的节点不编译
  const reach = new Set([triggers[0].id]);
  const stack = [triggers[0].id];
  while (stack.length > 0) {
    const id = stack.pop();
    for (const next of outgoing.get(id)) {
      if (!reach.has(next)) {
        reach.add(next);
        stack.push(next);
      }
    }
  }
  const warnings = [];
  const active = order.filter((id) => reach.has(id));
  for (const id of order) {
    if (!reach.has(id)) warnings.push(`节点 ${id} 从 trigger 走不到，已跳过`);
  }

  // 转义成模板字符串，再把 {{ref}} 换成 ${step_x}
  const escapeTpl = (text) =>
    String(text).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

  /**
   * 「上一段」的别名 —— 审批拆段后，段与段之间是靠一个**临时 trigger** 把上一段的结果带进来的：
   *   · 单门版（compileSplit）叫 `__approval_post_in`
   *   · 多门版（compileSplits）叫 `__seg<i>_in`
   * 名字对模板作者不友好，所以允许节点里写 `{{上一段}}`（或 `{{prev}}`），编译时映射过去。
   */
  const prevSegNodeId =
    [...byId.keys()].find((k) => /^__(?:seg\d+|approval_post)_in$/.test(k)) ?? null;
  /** 把用户写的引用名归一成真实节点 id（含「上一段」别名）。 */
  const resolveRefId = (ref) => {
    const key = ref.startsWith('step_') ? ref.slice(5) : ref;
    if ((key === '上一段' || key === 'prev') && prevSegNodeId !== null) return prevSegNodeId;
    return key;
  };

  const lines = [];
  const push = (s) => lines.push(s);
  /**
   * 图像节点的**产物回传文件**：nodeId → `<tmp>.result` 的绝对路径。
   * 为什么需要：官方端跑画布走的是 `tools.execute` 借道，**workflow/** 事件在 agent realm 内
   * emit、realm 外一条都收不到（实测），所以 `log('@@canvas-image@@…')` 那条路在这边不触发。
   * 于是让子代理把产物路径**写进约定文件**，host 轮询读它 → 广播缩略图。与路线无关。
   */
  const imageTmp = {};
  push('// ── dsh-canvas 编译产物（自动生成，别手改）──');
  push('const __canvas = { nodes: {}, order: [] };');
  // 从一段文本里挑出图片绝对路径：审批段之间传过来的往往是「路径 + 主人的修改意见」，
  // 直接当文件名会把意见文本也算进去（和 host 侧 findImagePath 同一套规则）。
  push(
    'const __pickPath = (v) => { const s = String(v == null ? "" : v); const m = s.match(/[A-Za-z]:[\\\\/][^\\n\\r]+?\\.(?:png|jpe?g|webp|gif)/i); return m ? m[0] : s.trim(); };',
  );
  // 从段间输入里只取出「主人的修改意见」那一小段（其余是路径/内部标记，塞给图像模型会变成乱码字画上去）
  push(
    'const __pickOpinion = (v) => { const s = String(v == null ? "" : v); const m = s.match(/【主人的修改意见】([\\s\\S]*)$/); return m ? m[1].trim() : ""; };',
  );
  // 内核要求返回值是纯 JSON：undefined / null 都不合法。
  // 分支图里「没跑的那一支」必然是 undefined，所以统一用它剔掉。
  push(
    'const __pick = (obj) => { const out = {}; for (const k of Object.keys(obj)) { const v = obj[k]; if (v !== undefined && v !== null) out[k] = v; } return out; };',
  );

  // phase 标题去重（meta.phases 与 phase() 必须逐字一致）
  const phaseTitles = [];
  const labelOf = (node) => {
    const raw = node?.data && typeof node.data.label === 'string' ? node.data.label.trim() : '';
    return raw || node.id;
  };
  const phaseFor = (node) => {
    let title = labelOf(node);
    let n = 2;
    while (phaseTitles.includes(title)) title = `${labelOf(node)} (${n++})`;
    phaseTitles.push(title);
    return title;
  };

  // 先把 agent 节点的 phase 标题收集齐 —— meta.phases 与脚本里的 phase() 必须**逐字一致**
  const phaseOf = new Map();
  for (const id of active) {
    const node = byId.get(id);
    if (node.type === 'agent' || node.type === 'image') phaseOf.set(id, phaseFor(node));
  }

  /** 控制流节点：它们的值不是数据（命中序号 / 路数），自动拼接时要穿透。 */
  const CONTROL_TYPES = new Set(['condition', 'parallel']);

  /**
   * 取一个节点的「**数据**上游」：遇到控制流节点就往上提升一层，
   * 直到拿到真正的数据节点（trigger / agent / code）。
   *
   * 为什么需要：parallel 的分叉 agent 直接上游是并行节点本身（值 = 路数、且此刻未赋值），
   * 直接拼上去就是 `【上游 p】undefined`；判断节点则是"命中序号"（1/2/3），同样没意义。
   */
  const dataUpstreamsOf = (id) => {
    const out = [];
    const push = (x) => {
      if (out.indexOf(x) < 0) out.push(x);
    };
    const walk = (nodeId, depth) => {
      if (depth > 6) return;
      for (const up of incoming.get(nodeId) ?? []) {
        if (!reach.has(up) || !byId.has(up)) continue;
        if (CONTROL_TYPES.has(byId.get(up).type)) walk(up, depth + 1);
        else push(up);
      }
    };
    walk(id, 0);
    return active.filter((x) => out.indexOf(x) >= 0);
  };

  /**
   * 构造 agent 节点的**提示词表达式**（字符串形式的 JS 源码）。
   * 含三件事：{{引用}} 替换、未引用时自动拼上游、以及「只输出结果」约束。
   * 抽出来是为了让 parallel 的分支复用同一套逻辑。
   */
  const agentPromptExpr = (id) => {
    const node = byId.get(id);
    const label = labelOf(node);
    const data = node.data && typeof node.data === 'object' ? node.data : {};
    const ups = dataUpstreamsOf(id);
    const usedRefs = new Set();
    const raw = typeof data.prompt === 'string' ? data.prompt : '';
    const body = escapeTpl(raw).replace(VAR_RE, (m, ref) => {
      const key = resolveRefId(ref);
      if (!byId.has(key)) throw new CanvasError(`节点「${label}」引用了不存在的节点 {{${ref}}}`);
      if (!reach.has(key)) throw new CanvasError(`节点「${label}」引用了走不到的上游 {{${ref}}}`);
      usedRefs.add(key);
      return `\${${varName(key)}}`;
    });
    // dataUpstreamsOf 已经把控制流节点穿透掉了，这里只需排除用户已显式引用的
    const auto = ups.filter((x) => !usedRefs.has(x));
    let tpl = '`' + body;
    for (const up of auto) tpl += '\\n\\n【上游 ' + up + '】\\n' + '${' + varName(up) + '}';
    tpl += '`';
    return data.terse === false ? tpl : `${tpl} + ${JSON.stringify(TERSE_SUFFIX)}`;
  };

  /**
   * 生成**单个节点**的代码行。
   *
   * `declare=false` 时用**赋值**而非 `const` 声明 —— 这是条件分支的关键：
   * 分支内的变量在块外先用 `let` 声明好了，块内只能赋值，否则块外（汇合点）看不见。
   */
  /** 有多个 output 节点时（分支各接一个输出），return 要合并到最后一次性发出。 */
  const outputIdsAll = active.filter((x) => byId.get(x).type === 'output');
  // 真正的判据在 inBranch 算完之后（见下方）—— 这里只占位，稍后 const 覆盖不了，
  // 所以用 let 并在后面赋值。
  let multiOutput = outputIdsAll.length > 1;

  const nodeLines = (id, declare) => {
    const node = byId.get(id);
    const v = varName(id);
    const label = labelOf(node);
    const data = node.data && typeof node.data === 'object' ? node.data : {};
    const ups = incoming.get(id).filter((x) => reach.has(x));
    const out = [];
    const put = (s) => out.push(s);
    const assign = declare ? `const ${v} =` : `${v} =`;
    // condition / code 要看到**所有祖先**（链式判断第二环也得能引用原始输入）；
    // agent 保持直接上游 —— 它的自动拼接不该塞进一堆无关内容。
    const inputKeys = node.type === 'condition' || node.type === 'code' ? ancestorsOf(id) : ups;
    const inputsObj = inputKeys.map((k) => `${JSON.stringify(k)}: ${varName(k)}`).join(', ');

    if (node.type === 'trigger') {
      const seed = typeof data.prompt === 'string' ? data.prompt : '';
      put(`// [trigger] ${label}`);
      put(
        `${assign} (args && typeof args.prompt === 'string' && args.prompt.length > 0) ? args.prompt : ${JSON.stringify(seed)};`,
      );
      put(`__canvas.nodes[${JSON.stringify(id)}] = ${v};`);
      put(`__canvas.order.push(${JSON.stringify(id)});`);
      return out;
    }

    if (node.type === 'agent') {
      // 失败重试次数（0 = 不重试）。内核的 agent() 失败时返回 null，所以判断就是 !== null。
      const retryTimes = Number.isFinite(Number(data.retry))
        ? Math.max(0, Math.min(5, Math.floor(Number(data.retry))))
        : 0;
      put(`// [agent] ${label}${data.terse === false ? '' : '（只输出结果）'}${retryTimes > 0 ? `（失败重试 ${retryTimes} 次）` : ''}`);
      put(`phase(${JSON.stringify(phaseOf.get(id) ?? label)});`);
      if (retryTimes > 0) {
        const loopVar = `__t_${safeIdent(id, 'n')}`;
        if (declare) put(`let ${v};`);
        put(`for (let ${loopVar} = 0; ${loopVar} <= ${retryTimes}; ${loopVar}++) {`);
        put(`  ${v} = await agent(${agentPromptExpr(id)}, { label: ${JSON.stringify(label)} });`);
        put(`  if (${v} !== null) break;`);
        put(`  log(${JSON.stringify(`${label} 第 `)} + (${loopVar} + 1) + ${JSON.stringify(' 次没成功，重试')});`);
        put(`}`);
      } else {
        put(`${assign} await agent(${agentPromptExpr(id)}, { label: ${JSON.stringify(label)} });`);
      }
      put(`__canvas.nodes[${JSON.stringify(id)}] = ${v};`);
      put(`__canvas.order.push(${JSON.stringify(id)});`);
      put(`log(${JSON.stringify(`${label} 完成`)});`);
      return out;
    }

    // image 节点：本质是「带固定剧本的子代理」—— 跑本机的 image-edit.mjs 出图/改图，
    // 只把产物路径带回来（下游节点可以 {{引用}} 这个路径接着改）。
    // 为什么必须走子代理：workflow 的 vm 沙箱里**没有 fetch / require / fs**（见文件头）。
    if (node.type === 'image') {
      const instructionRaw = typeof data.prompt === 'string' ? data.prompt : '';
      if (instructionRaw.trim() === '') {
        throw new CanvasError(`图像节点「${label}」还没写「图像指令」（data.prompt）`);
      }
      /** {{refs}} 替换（指令与参考图都支持引用上游）。 */
      const renderRefs = (raw) =>
        escapeTpl(raw).replace(VAR_RE, (m, ref) => {
          const key = resolveRefId(ref);
          if (!byId.has(key)) throw new CanvasError(`节点「${label}」引用了不存在的节点 {{${ref}}}`);
          if (!reach.has(key)) throw new CanvasError(`节点「${label}」引用了走不到的上游 {{${ref}}}`);
          return `\${${varName(key)}}`;
        });

      const imageRaw = typeof data.image === 'string' ? data.image.trim() : '';
      const kind = imageRaw === '' ? 'gen' : 'edit';

      // 指令表达式：{{引用}} + 自动拼上游（和 agent 同一套语义，方便「接着上一张改」）
      //
      // ⚠️ 但**段间入口**（审批拆段带进来的 `__seg<i>_in` / `__approval_post_in`）不能整坨塞进去：
      //    它的值 = 「上一张图的本地路径 + 【主人的修改意见】xxx」，整坨塞给图像模型会让它
      //    把这些文字**当成要画的内容**（实测：画面上印满乱码字，人物还漂移了）。
      //    所以段间入口只取「主人的修改意见」那一小段。
      const usedRefs = new Set();
      for (const ref of instructionRaw.matchAll(VAR_RE)) usedRefs.add(String(ref[1] ?? '').replace(/^step_/, ''));
      const isSegEntry = (x) => /^__(?:seg\d+|approval_post)_in$/.test(x);
      let tplBody = renderRefs(instructionRaw);
      const opinionFroms = [];
      for (const up of incoming.get(id).filter((x) => reach.has(x))) {
        const upType = byId.get(up)?.type;
        if (usedRefs.has(up) || upType === 'condition' || upType === 'parallel') continue;
        if (isSegEntry(up)) opinionFroms.push(varName(up));
        else tplBody += '\\n\\n【上游 ' + up + '】\\n${' + varName(up) + '}';
      }
      let instructionExpr = '`' + tplBody + '`';
      for (const v of opinionFroms) {
        instructionExpr =
          `(${instructionExpr} + (__pickOpinion(${v}) !== ""` +
          ` ? "\\n\\n【要改的地方】" + __pickOpinion(${v})` +
          ` : "\\n\\n（主人没写具体意见：保持人物、姿势与构图不变，把画面再精修一版）"))`;
      }
      const imageExpr = imageRaw === '' ? 'null' : `__pickPath(${'`' + renderRefs(imageRaw) + '`'})`;

      const provider =
        typeof data.provider === 'string' && data.provider.trim() !== '' ? data.provider.trim() : 'dashscope';
      const modelExpr =
        typeof data.model === 'string' && data.model.trim() !== '' ? JSON.stringify(data.model.trim()) : 'null';
      const outDir =
        typeof data.out === 'string' && data.out.trim() !== ''
          ? data.out.trim()
          : path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-canvas', 'images');
      const scriptPath = path.join(os.homedir(), '.dsh', 'image-edit.mjs');
      const tmpFile = path.join(os.tmpdir(), `canvas-img-${safeIdent(id, 'node')}.txt`);
      imageTmp[id] = `${tmpFile}.result`;

      // 固定剧本（用 JSON 字面量嵌进生成的脚本，避免转义地狱）
      const fixedLines = [
        '你是画布上的「图像节点」，负责调用本机脚本出图/改图。严格按三步做，不要自由发挥：',
        `① 用 write 工具把下面【图像指令】的原文（一字不改）写到文件：${tmpFile}`,
        kind === 'edit'
          ? '② 用 bash 运行这一条命令（照抄；<参考图> 换成下面【参考图】里的路径）：'
          : '② 用 bash 运行这一条命令（照抄，把 <参考图> 三个字连同前面的空格一起删掉）：',
        `   node "${scriptPath}" ${kind}${kind === 'edit' ? ' <参考图>' : ''} --prompt-file "${tmpFile}"${kind === 'edit' ? ' --provider ' + provider : ''} --out "${outDir}"`,
        modelExpr === 'null' ? '' : `   （想指定模型就再加： --model <模型名>）`,
        '③ 命令会打印「✔ 已存: <绝对路径>」。把那个**绝对路径**作为你的唯一回复输出——除了路径，什么都不要输出。',
        `④ 再用 write 工具把命令最后那行 **META 开头的整行**（原样、一字不改）写进这个文件：${tmpFile}.result`,
        '   （那行是机器读的元信息，里面有产物路径、耗时、花费 —— 写进去画布上就能显示出来）',
        '',
        '【图像指令】',
      ].filter((x) => x !== '');

      const promptSource =
        JSON.stringify(fixedLines.join('\n')) +
        ' + "\\n" + (' + instructionExpr + ')' +
        (imageExpr === 'null' ? '' : ' + "\\n\\n【参考图】\\n" + (' + imageExpr + ')');

      put(`// [image] ${label}（${kind} · ${provider}）`);
      put(`phase(${JSON.stringify(phaseOf.get(id) ?? label)});`);
      put(`${assign} await agent(${promptSource}, { label: ${JSON.stringify(label)} });`);
      put(`__canvas.nodes[${JSON.stringify(id)}] = ${v};`);
      put(`__canvas.order.push(${JSON.stringify(id)});`);
      // 把产物路径回传给 host（host 解析后转成 canvas/node + preview，前端贴缩略图）
      put(
        `log(${JSON.stringify('@@canvas-image@@')} + JSON.stringify({ nodeId: ${JSON.stringify(id)}, raw: ${v} }));`,
      );
      put(`log(${JSON.stringify(`${label} 完成`)});`);
      return out;
    }

    // code 节点：把用户片段原样内联进一个 async IIFE，上游以 inputs 对象暴露。
    // 用户 return 什么，这个节点的值就是什么。
    if (node.type === 'code') {
      const snippet = typeof data.code === 'string' ? data.code : '';
      if (snippet.trim() === '') {
        throw new CanvasError(`code 节点「${label}」还没有代码`);
      }
      put(`// [code] ${label}`);
      put(`${assign} await (async () => {`);
      put(`  const inputs = { ${inputsObj} };`);
      for (const line of snippet.split('\n')) put(`  ${line}`);
      put(`})();`);
      put(`__canvas.nodes[${JSON.stringify(id)}] = ${v};`);
      put(`__canvas.order.push(${JSON.stringify(id)});`);
      return out;
    }

    // condition 节点：求值成真/假，下面的 if/else 由结构层包出来。
    if (node.type === 'condition') {
      const expr = typeof data.expr === 'string' ? data.expr : '';
      if (expr.trim() === '') {
        throw new CanvasError(`condition 节点「${label}」还没有条件表达式`);
      }
      // ⚠️ 条件必须是 **JS 表达式**。填成中文句子是这里最容易踩的坑 ——
      // 引擎只会回一句看不懂的 `ReferenceError: xxx is not defined`，
      // 所以在这里就拦下来，并把「该怎么写」直接说清楚。
      const bare = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
      if (/[\u4e00-\u9fff]/.test(bare)) {
        throw new CanvasError(
          `判断节点「${label}」的条件写成了中文句子：「${expr}」。\n` +
            `条件要写 JS 表达式、并用 inputs 引用上游，例如：inputs.n2 > 50 && inputs.n2 <= 100`,
        );
      }
      // 语法预检（只编译不执行）—— 抓漏括号、写错运算符之类
      try {
        // eslint-disable-next-line no-new-func
        new Function('inputs', `return (${expr});`);
      } catch (err) {
        throw new CanvasError(`判断节点「${label}」的条件不是合法 JS：${expr}（${err?.message ?? err}）`);
      }
      put(`// [condition] ${label}`);
      put(`${assign} await (async () => {`);
      put(`  const inputs = { ${inputsObj} };`);
      put(`  return (${expr});`);
      put(`})();`);
      put(`log(${JSON.stringify(`${label} → `)} + String(${v}));`);
      put(`__canvas.nodes[${JSON.stringify(id)}] = ${v};`);
      put(`__canvas.order.push(${JSON.stringify(id)});`);
      return out;
    }

    if (node.type !== 'output') {
      // condition / parallel 由结构层处理，不该走到这里；真走到了说明漏了分支，
      // 早点炸掉比悄悄生成错代码强（独立审查实测过：parallel 掉进这里被当成 output）。
      throw new CanvasError(`内部错误：节点类型 ${String(node.type)} 不该走到单节点生成（漏了结构层分支？）`);
    }

    // output
    put(`// [output] ${label}（工作流的返回值）`);
    // ⚠️ 也要**穿透控制流节点**取数据上游：直接上游若是判断节点，
    // 取到的是「命中第几路」这种没意义的值（独立审查实测到 {"result":1}）。
    const dataUps = dataUpstreamsOf(id);
    const keys = dataUps.length > 0 ? dataUps : active.filter((x) => x !== id);
    const obj = keys.map((k) => `${JSON.stringify(k)}: ${varName(k)}`).join(', ');
    put(`__canvas.nodes[${JSON.stringify(id)}] = __pick({ ${obj} });`);
    if (!multiOutput) {
      // 只有一个 output 时就地 return（多 output 的情况在主循环之后统一汇总）
      put(`const __vals = Object.keys(__canvas.nodes[${JSON.stringify(id)}]).map((k) => __canvas.nodes[${JSON.stringify(id)}][k]);`);
      put(
        `return { result: __vals.length > 0 ? __vals[0] : null, outputs: __canvas.nodes[${JSON.stringify(id)}], __canvas: { order: __canvas.order } };`,
      );
    }
    return out;
  };

  /**
   * 某节点的**所有可达祖先**（按拓扑序）。
   * condition / code 的 `inputs` 用它 —— 链式判断的第二环也要能读到原始输入，
   * 只给直接上游的话 `inputs.n1` 会是 undefined（实测：7 > 5 被判成 false）。
   */
  const ancestorsCache = new Map();
  const ancestorsOf = (id) => {
    if (ancestorsCache.has(id)) return ancestorsCache.get(id);
    const seen = new Set();
    const stack = [...incoming.get(id)];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur) || !byId.has(cur) || !reach.has(cur)) continue;
      seen.add(cur);
      for (const prev of incoming.get(cur)) stack.push(prev);
    }
    const list = active.filter((x) => seen.has(x));
    ancestorsCache.set(id, list);
    return list;
  };

  // ── 条件分支的区域分析（支持链式：分支里可以再放 condition）──
  /** 从若干起点出发可达的节点集合（不穿过 stop 里的节点）。 */
  const reachFrom = (starts, stop) => {
    const seen = new Set();
    const stack = [...starts];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur) || stop.has(cur) || !byId.has(cur)) continue;
      seen.add(cur);
      for (const next of outgoing.get(cur)) stack.push(next);
    }
    return seen;
  };

  /**
   * 条件必须是**合法 JS 表达式**（中文句子是这里最大的坑：引擎只会回一句看不懂的
   * `ReferenceError: xxx is not defined`，所以在这里就拦下来说清楚）。
   */
  const assertJsExpr = (expr, where) => {
    const bare = String(expr).replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
    if (/[\u4e00-\u9fff]/.test(bare)) {
      throw new CanvasError(
        `${where}的条件写成了中文句子：「${expr}」。\n` +
          `条件要写 JS 表达式、并用 inputs 引用上游，例如：inputs.n2 > 50 && inputs.n2 <= 100`,
      );
    }
    try {
      // eslint-disable-next-line no-new-func
      new Function('inputs', `return (${expr});`);
    } catch (err) {
      throw new CanvasError(`${where}的条件不是合法 JS：${expr}（${err?.message ?? err}）`);
    }
  };

  /**
   * conditionId → { arms: [{ expr, isElse, nodeIds }], hasFallback }
   * 每条出边就是「一路」（多路扇出）；按边在 edges 里的顺序依次试。
   */
  const branchRegions = new Map();
  for (const id of active) {
    const node = byId.get(id);
    if (node.type !== 'condition') continue;

    const outEdges = edges.filter((e) => e.from === id);
    if (outEdges.length === 0) {
      throw new CanvasError(`判断节点「${labelOf(node)}」没有出边：至少接一条`);
    }

    const stop = new Set([id]);
    const nodeExpr =
      node.data && typeof node.data.expr === 'string' && node.data.expr.trim() !== '' ? node.data.expr.trim() : null;

    const arms = outEdges.map((e) => {
      const own = typeof e.expr === 'string' && e.expr.trim() !== '' ? e.expr.trim() : null;
      const isElse = e.branch === 'else';
      let expr = own;
      // 兼容老图：边没写条件时，then 沿用节点自带的 expr
      if (expr === null && !isElse && nodeExpr !== null) expr = nodeExpr;
      return { edgeId: String(e.id ?? ''), toId: String(e.to), expr, isElse, reach: reachFrom([e.to], stop) };
    });

    // 汇合点 = 被 2 路以上可达（留在整条 if/else 之后）
    const hits = new Map();
    for (const arm of arms) {
      for (const nid of arm.reach) hits.set(nid, (hits.get(nid) || 0) + 1);
    }
    const merge = new Set();
    for (const [nid, count] of hits) if (count >= 2) merge.add(nid);

    for (const arm of arms) {
      arm.nodeIds = active.filter((x) => arm.reach.has(x) && !merge.has(x));
    }

    // 每条**带条件**的出边都要过校验（中文 / JS 语法）
    arms.forEach((arm, idx) => {
      if (arm.expr !== null) {
        assertJsExpr(arm.expr, `判断节点「${labelOf(node)}」第 ${idx + 1} 条出边`);
      }
    });

    for (const nid of merge) {
      if (byId.get(nid)?.type === 'trigger') throw new CanvasError(`trigger 不能出现在分支里（节点 ${nid}）`);
    }
    for (const arm of arms) {
      for (const nid of arm.nodeIds) {
        if (byId.get(nid)?.type === 'trigger') throw new CanvasError(`trigger 不能出现在分支里（节点 ${nid}）`);
      }
    }

    // 无条件的路（兜底）只能有一条，且必须排在最后
    const fallbacks = [];
    arms.forEach((arm, idx) => {
      if (arm.expr === null) fallbacks.push(idx);
    });
    if (fallbacks.length > 1) {
      throw new CanvasError(`判断节点「${labelOf(node)}」有多条无条件出边：只能留一条兜底，其余请填条件`);
    }
    if (fallbacks.length === 1 && fallbacks[0] !== arms.length - 1) {
      throw new CanvasError(`判断节点「${labelOf(node)}」的无条件出边必须排在最后（把它挪到末位，或给它填个条件）`);
    }
    // ⚠️ 首路必须是**带条件**的：否则生成的 if/else 链会以 `else {` 开头 → 语法错误。
    // （独立审查实测复现：单路 + 无条件 + 节点 expr 也空 → SyntaxError: Unexpected token else）
    if (arms.length > 0 && arms[0].expr === null) {
      throw new CanvasError(
        `判断节点「${labelOf(node)}」的第一条出边必须带条件：` +
          `请在连线上填一个 JS 表达式（如 inputs.n2 > 50）；无条件那条只能放在最后当兜底`,
      );
    }

    branchRegions.set(id, { kind: 'condition', arms, hasFallback: fallbacks.length === 1 });
  }

  // ── 并行节点：每条出边就是一个并行分叉（P1 只允许接子代理） ──
  for (const id of active) {
    const node = byId.get(id);
    if (node.type !== 'parallel') continue;

    const outEdges = edges.filter((e) => e.from === id);
    if (outEdges.length === 0) {
      throw new CanvasError(`并行节点「${labelOf(node)}」没有出边：至少接一条分叉`);
    }

    const stop = new Set([id]);
    const arms = outEdges.map((e) => {
      const headId = String(e.to);
      const head = byId.get(headId);
      if (!head || head.type !== 'agent') {
        throw new CanvasError(
          `并行节点「${labelOf(node)}」的每条分叉目前只能接「子代理」节点（${headId} 是 ${String(head?.type)}）`,
        );
      }
      return { edgeId: String(e.id ?? ''), headId, reach: reachFrom([headId], stop) };
    });

    const hits = new Map();
    for (const arm of arms) {
      for (const nid of arm.reach) hits.set(nid, (hits.get(nid) || 0) + 1);
    }
    const merge = new Set();
    for (const [nid, count] of hits) if (count >= 2) merge.add(nid);

    for (const arm of arms) {
      arm.nodeIds = active.filter((x) => arm.reach.has(x) && !merge.has(x));
    }

    branchRegions.set(id, { kind: 'parallel', arms, hasFallback: false });
  }

  // ── 输出：按拓扑序走 ──
  // 落在「某个分支区域里」的节点（含嵌套 condition 自己）一律**顶层 let 声明**、
  // 分支内用赋值 —— 否则块外（汇合点）看不见这些变量。
  const inBranch = new Set();
  for (const region of branchRegions.values()) {
    for (const arm of region.arms) {
      for (const x of arm.nodeIds) inBranch.add(x);
    }
  }
  // 判断节点自己的「命中序号」变量也一律顶层声明 ——
  // 它会在嵌套花括号里被赋值，块外（汇合点）要能读到。
  for (const cid of branchRegions.keys()) inBranch.add(cid);

  // ⚠️ 现在才能给出**准确**的 multiOutput 判据：
  // **只要有 output 落在任何分支区域里**（或者不止一个 output），就必须走「合并 return」。
  // 否则唯一那个 output 在某条分支里时，未命中的路径会走到函数末尾返回 undefined，
  // 而内核要求返回值必须是纯 JSON（独立审查实测）。
  const outputsInBranch = outputIdsAll.filter((oid) => inBranch.has(oid));
  multiOutput = outputIdsAll.length > 1 || outputsInBranch.length > 0;

  const emitted = new Set();

  /** 输出一个「区域」：里面的节点按顺序生成；遇到 condition 就再展开一层。 */
  const emitRegion = (ids, indent) => {
    for (const nid of ids) {
      if (emitted.has(nid)) continue;
      const inner = byId.get(nid);
      if (inner.type === 'condition' && branchRegions.has(nid)) {
        emitCondition(nid, indent);
      } else if (inner.type === 'parallel' && branchRegions.has(nid)) {
        emitParallel(nid, indent);
      } else {
        for (const line of nodeLines(nid, !inBranch.has(nid))) push(indent + line);
        emitted.add(nid);
      }
    }
  };

  /**
   * 输出判断节点：N 条出边 → if / else if / else。
   * 外面套一对花括号，好让 `inputs` 只在链内可见（多路共用一个 inputs）。
   */
  const emitCondition = (id, indent) => {
    emitted.add(id);
    const region = branchRegions.get(id);
    const node = byId.get(id);
    const label = labelOf(node);
    const inputsObj = ancestorsOf(id)
      .map((k) => `${JSON.stringify(k)}: ${varName(k)}`)
      .join(', ');

    push(`${indent}// [condition] ${label}（${region.arms.length} 路）`);
    push(`${indent}{`);
    push(`${indent}  const inputs = { ${inputsObj} };`);

    region.arms.forEach((arm, idx) => {
      const kw = idx === 0 ? 'if' : 'else if';
      if (arm.expr === null) {
        push(`${indent}  else {`);
      } else {
        push(`${indent}  ${kw} (${arm.expr}) {`);
      }
      push(`${indent}    ${varName(id)} = ${idx + 1};`);
      if (arm.nodeIds.length === 0) {
        push(`${indent}    /* 这一路没有节点 */`);
      } else {
        emitRegion(arm.nodeIds, indent + '    ');
      }
      push(`${indent}  }`);
    });

    if (!region.hasFallback) {
      push(`${indent}  else {`);
      push(`${indent}    ${varName(id)} = ${region.arms.length + 1};`);
      push(`${indent}  }`);
    }

    push(`${indent}  __canvas.nodes[${JSON.stringify(id)}] = ${varName(id)};`);
    push(`${indent}}`);
  };

  // 顶层变量统一声明（顺序按拓扑序，方便读）
  const branchVars = active.filter((id) => inBranch.has(id));
  if (branchVars.length > 0) {
    push(`// 分支内用到的变量先声明 —— 块外（汇合点）也要能读到`);
    push(`let ${branchVars.map((x) => varName(x)).join(', ')};`);
  }

  /** 输出并行节点：N 条分叉同时跑，全部完成才继续。 */
  const emitParallel = (id, indent) => {
    emitted.add(id);
    const region = branchRegions.get(id);
    const node = byId.get(id);
    const label = labelOf(node);
    const inputsObj = ancestorsOf(id)
      .map((k) => `${JSON.stringify(k)}: ${varName(k)}`)
      .join(', ');
    const parVar = `__par_${safeIdent(id, 'p')}`;

    push(`${indent}// [parallel] ${label}（${region.arms.length} 路并行）`);
    push(`${indent}{`);
    push(`${indent}  const inputs = { ${inputsObj} };`);
    push(`${indent}  const ${parVar} = await parallel([`);
    for (const arm of region.arms) {
      const head = byId.get(arm.headId);
      push(
        `${indent}    () => agent(${agentPromptExpr(arm.headId)}, { label: ${JSON.stringify(labelOf(head))} }),`,
      );
    }
    push(`${indent}  ]);`);

    region.arms.forEach((arm, idx) => {
      push(`${indent}  ${varName(arm.headId)} = ${parVar}[${idx}];`);
      push(`${indent}  __canvas.nodes[${JSON.stringify(arm.headId)}] = ${varName(arm.headId)};`);
      push(`${indent}  __canvas.order.push(${JSON.stringify(arm.headId)});`);
      emitted.add(arm.headId);
    });

    push(`${indent}  __canvas.nodes[${JSON.stringify(id)}] = ${parVar}.length;`);
    push(`${indent}  log(${JSON.stringify(`${label}：${region.arms.length} 路并行完成`)});`);
    push(`${indent}}`);
  };

  for (const id of active) {
    if (emitted.has(id)) continue;
    const node = byId.get(id);
    const region = branchRegions.get(id);
    if (node.type === 'condition' && region) {
      emitCondition(id, '');
      continue;
    }
    if (node.type === 'parallel' && region) {
      emitParallel(id, '');
      continue;
    }
    for (const line of nodeLines(id, !inBranch.has(id))) push(line);
    emitted.add(id);
  }

  // 多个 output 节点 → 合并成**一个** return，放在所有节点之后。
  // 否则第一个 output 就地 return，后面那条分支的节点永远不会被执行。
  if (multiOutput) {
    const mergeKeys = [];
    for (const oid of active) {
      if (byId.get(oid).type !== 'output') continue;
      // ⚠️ 同样要**穿透控制流节点**：直接上游若是判断/并行，取到的是命中序号或路数，
      // 汇总出来就是 `{"n2": 1}` 这种没意义的东西（测试实测到）。
      for (const up of dataUpstreamsOf(oid)) {
        if (!mergeKeys.includes(up)) mergeKeys.push(up);
      }
    }
    const obj = mergeKeys.map((k) => `${JSON.stringify(k)}: ${varName(k)}`).join(', ');
    push('// [汇总] 多个输出节点 → 合并成一个 return');
    push(`const __canvasOut = __pick({ ${obj} });`);
    // ⚠️ result 不能取「最后一个上游变量」—— 那多半是**没跑的那条分支**（值为 undefined）。
    // 改成取第一个**真有值**的输出，这样 then / else 哪条跑了都能正确回值。
    push(
      `const __canvasVals = Object.keys(__canvasOut).map((k) => __canvasOut[k]).filter((v) => v !== undefined && v !== null);`,
    );
    push(
      `return { result: __canvasVals.length > 0 ? __canvasVals[0] : null, outputs: __canvasOut, __canvas: { order: __canvas.order } };`,
    );
  }

  const name0 = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : '';
  const meta = {
    name: kebab(name0, 'canvas-run'),
    description: (name0 ? `画布工作流：${name0}` : 'dsh-canvas 画布工作流').replace(/\s+/g, ' ').slice(0, 180),
  };
  if (phaseTitles.length > 0) meta.phases = phaseTitles.map((title) => ({ title }));

  return {
    script: `${lines.join('\n')}\n`,
    meta,
    order: active,
    warnings,
    nodesById: Object.fromEntries(byId),
    imageTmp,
  };
}

// ─────────────────────────── HTTP 小工具 ───────────────────────────

function sendJson(res, code, data) {
  let body;
  try {
    body = JSON.stringify(data, null, 2);
  } catch (err) {
    body = JSON.stringify({ ok: false, error: `结果无法序列化：${err?.message ?? err}` });
    code = 500;
  }
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 4 * 1024 * 1024) {
  // CSRF 防护：只接受 application/json。
  // 跨站网页的「简单请求」**不能**带 application/json（那会被浏览器先发 OPTIONS 预检，
  // 而本服务不响应预检）→ 于是拿不到这条通道。评审实测过：之前 text/plain 也能打进来。
  const ctype = String(req.headers?.['content-type'] ?? '');
  if (!ctype.includes('application/json')) {
    const ctError = new Error('content-type 必须是 application/json（本接口不接受跨站简单请求）');
    ctError.statusCode = 415;
    return Promise.reject(ctError);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err?.message ?? err}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 画布文件名。
 * ⚠️ 不能用 `safeIdent` —— 它会把 `-` 换成 `_`，而历史上有些文件名是带横线的
 * （`canvas-<时间戳>` fallback），两边规则不一致就会「存得进去、删不掉」。
 * 这里只保留 `[A-Za-z0-9_-]`，足够挡住 `/`、`\`、`.` 等路径字符。
 */
function graphFileName(raw) {
  return String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '');
}

/** 取存盘目录（确保已创建）—— GET 与 POST 两条分支共用。 */
function graphDir() {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
  return GRAPH_DIR;
}

/** 只取叶子的 id 字符串，绝不 JSON 化活对象。 */
function agentIds(agents) {
  try {
    if (!agents || typeof agents.list !== 'function') return [];
    return agents.list().map((a) => String(a?.id ?? ''));
  } catch {
    return [];
  }
}

// ─────────────────────────── 探针 ───────────────────────────

/**
 * 自检：三个服务在不在 + `ctx.agents.get()` 能不能拿到 Agent。
 *
 * ⚠️ 引擎那一栏看的是 **第二层 inject 有没有就绪**，不是 `ctx.get('workflowEngine')`
 * —— 后者因为惰性激活必然返回 undefined，拿它当判据会得出"引擎不存在"的错误结论。
 * 两者都报出来，方便以后排障对比。
 *
 * @param state mount() 里的共享状态 { engineReady, engine }
 */
function probe(ctx, sessionId, state) {
  const webServer = ctx.get('webServer');
  const agents = ctx.get('agents');
  const engineReady = state?.engineReady === true;
  const toolsExecute = typeof ctx.get('tools')?.execute === 'function';

  const live = agentIds(agents);
  const wanted = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
  let resolved = null;
  let error = null;

  try {
    if (typeof agents?.get !== 'function') {
      error = 'agents 服务没有 get()';
    } else {
      const target = wanted ?? live[0] ?? null;
      if (target === null) {
        error = '当前没有任何活跃 agent';
      } else {
        const agent = agents.get(target);
        resolved = agent
          ? { id: String(agent.id), matched: true, requested: target, source: wanted ? 'query.sessionId' : 'agents.list()[0]' }
          : { id: null, matched: false, requested: target, source: wanted ? 'query.sessionId' : 'agents.list()[0]' };
      }
    }
  } catch (err) {
    error = `agents.get() 抛错：${err?.message ?? err}`;
  }

  let roots = [];
  try {
    if (typeof agents?.roots === 'function') roots = agents.roots().map((a) => String(a?.id ?? ''));
  } catch {
    roots = [];
  }

  return {
    ok: Boolean(webServer) && !error && resolved?.matched === true && (engineReady || toolsExecute),
    plugin: name,
    version: '0.1.0',
    services: {
      webServer: typeof webServer?.register === 'function',
      agents: typeof agents?.get === 'function',
      workflowEngine: engineReady,
      toolsExecute,
    },
    engineReady,
    workflowEngineViaGet: typeof ctx.get('workflowEngine')?.start === 'function',
    route: engineReady ? 'engine' : toolsExecute ? 'tools.execute' : 'none',
    liveAgents: { count: live.length, ids: live, roots },
    resolved,
    activeRuns: [...runs.keys()],
    error,
  };
}

// ─────────────────────────── 运行 ───────────────────────────

function broadcast(runId, event, payload) {
  const frame = { runId, event, at: Date.now(), ...payload };
  recent.push(frame);
  while (recent.length > RECENT_MAX) recent.shift();
  const data = JSON.stringify(frame);
  for (const client of sseClients) {
    if (client.runId !== null && client.runId !== runId) continue;
    try {
      client.res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

/**
 * `compiled.nodesById` → 「label → nodeId」表。
 *
 * 为什么需要：内核的 `workflow/agent-start|agent-end` 只给 `label`（= `node.data.label || node.id`），
 * 前端按 label 点灯在**同名节点**或**改名**时会错。这里在 host 侧还原成稳定 id，
 * 前端就能按 id 上色（label 仍照发，向后兼容）。
 */
export function labelIndex(compiled) {
  const map = new Map();
  const byId = compiled?.nodesById ?? {};
  for (const id of Object.keys(byId)) {
    const node = byId[id];
    const raw = node?.data && typeof node.data.label === 'string' ? node.data.label.trim() : '';
    const label = raw || id;
    if (!map.has(label)) map.set(label, id);
  }
  return map;
}

/** 用 run 的 label 表把 label 还原成 nodeId（查不到就返回 null，前端会退回按 label 匹配）。 */
function nodeIdOf(runId, label) {
  const entry = runs.get(String(runId));
  const map = entry?.labelToId;
  if (!map || typeof map.get !== 'function') return null;
  const hit = map.get(String(label ?? ''));
  return hit === undefined ? null : hit;
}

/** 图像节点回传标记：编译出来的脚本用它把产物路径带出来（对用户不可见）。 */
const IMAGE_MARK = '@@canvas-image@@';

/**
 * 从一段文本里捞出**最后一个**图片绝对路径。
 * 子代理的回复可能夹带解释文字，所以不要求"整段就是路径"，只要求里面有路径。
 */
export function findImagePath(text) {
  const re = /[A-Za-z]:[\\/][^\n\r"'<>|?*]+?\.(?:png|jpe?g|webp|gif)/gi;
  const hits = String(text ?? '').match(re);
  return hits && hits.length > 0 ? hits[hits.length - 1] : null;
}

/**
 * 从 `image-edit.mjs` 的 `META {json}` 行解析元信息（模型 / 耗时 / 花费 / 产物路径）。
 * @returns {object|null}
 */
export function parseImageMeta(text) {
  const hit = String(text ?? '').match(/^\s*META\s+(\{.*\})\s*$/m);
  if (!hit) return null;
  try {
    const j = JSON.parse(hit[1]);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** 把元信息拼成人类可读的一行（节点下面显示这个）。 */
export function describeImageMeta(meta, fallbackPath) {
  if (!meta) return fallbackPath ?? null;
  const parts = [];
  const who = [meta.provider, meta.model].filter(Boolean).join(' · ');
  if (who) parts.push(who);
  if (Number.isFinite(Number(meta.seconds))) parts.push(`${Number(meta.seconds)}s`);
  if (meta.size) parts.push(String(meta.size));
  if (meta.images && Number(meta.images) > 1) parts.push(`${meta.images} 图输入`);
  if (meta.cost && typeof meta.cost === 'object') {
    if (meta.cost.unit === '元') {
      parts.push(Number(meta.cost.value) > 0 ? `≈¥${meta.cost.value}` : String(meta.cost.note ?? '免费'));
    } else {
      parts.push(`${meta.cost.value} ${meta.cost.unit}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : (fallbackPath ?? null);
}

/**
 * 轮询「图像节点的产物回传文件」→ 广播 `canvas/node` + preview（缩略图）+ detail（模型/耗时/花费）。
 *
 * 为什么要这条通道：官方端跑画布是**借道 `tools.execute`**，而 `workflow/*` 事件在 agent realm
 * 内 emit、realm 外收不到（实测一条都没有）→ 靠 `log('@@canvas-image@@')` 那条路不会触发。
 * 走文件就与执行路线无关了。
 *
 * @returns {() => void} 停止函数
 */
function startImagePreviewPoll(runId, imageTmp, intervalMs = 1500) {
  const ids = Object.keys(imageTmp ?? {});
  if (ids.length === 0) return () => {};
  const seen = new Map();
  // 开跑前清掉上一次的残file，免得旧图被当成这次的产物
  for (const id of ids) {
    try {
      fs.unlinkSync(imageTmp[id]);
    } catch {
      /* 本来就没有 */
    }
  }
  const timer = setInterval(() => {
    // run 已经结束了（runs 里没有了）→ 自己停，不用调用方记着关
    if (!runs.has(runId)) {
      clearInterval(timer);
      return;
    }
    for (const id of ids) {
      let txt = '';
      try {
        txt = fs.readFileSync(imageTmp[id], 'utf8');
      } catch {
        continue;
      }
      const meta = parseImageMeta(txt);
      const p = (meta && typeof meta.path === 'string' ? meta.path : null) || findImagePath(txt);
      if (!p || seen.get(id) === p) continue;
      seen.set(id, p);
      broadcast(runId, 'canvas/node', {
        nodeId: id,
        state: 'done',
        preview: { kind: 'image', path: p },
        // 节点下面显示「provider · model · 耗时 · 尺寸 · 花费」
        detail: describeImageMeta(meta, p),
        meta,
        source: 'image-file',
      });
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

function pickParent(agents, sessionId) {
  if (typeof sessionId === 'string' && sessionId !== '' && typeof agents.get === 'function') {
    const hit = agents.get(sessionId);
    if (hit) return hit;
  }
  if (typeof agents.roots === 'function') {
    const roots = agents.roots();
    if (roots.length > 0) return roots[roots.length - 1];
  }
  if (typeof agents.list === 'function') {
    const all = agents.list();
    if (all.length > 0) return all[all.length - 1];
  }
  return undefined;
}

/**
 * 从 `workflow` 工具的返回值里把脚本 `return` 出来的 raw 文本抠出来。
 * 形状：ToolExecutionResult.value = { runId, agentsStarted, result: { raw } }。
 */
function pickGeneratedText(result) {
  const v = result && typeof result === "object" ? result.value : undefined;
  const inner = v && typeof v === "object" ? v.result : undefined;
  if (inner && typeof inner === "object" && typeof inner.raw === "string") return inner.raw;
  if (typeof inner === "string") return inner;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/** 把任意值截成一句可读预览（给审批卡片和结果区用）。 */
function summarizeValue(value, max = 400) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (typeof s !== 'string') s = String(s);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 带审批的运行：段1 → 问人 → 段2。
 *
 * ⚠️ 为什么不在一段脚本里"停下来"：内核 workflow 脚本**没有暂停机制**
 * （worker 只注入 6 个全局、宿主↔worker 无数据通道）。所以"等待"只能发生在**段与段之间** ——
 * 那时没有 worker，等待零成本、也不受任何超时约束。
 */
/** 把主人的自由文字意见拼进下一段的输入。 */
function withInstruction(value, instruction) {
  if (!instruction) return value;
  return `${typeof value === 'string' ? value : JSON.stringify(value)}\n\n【主人的修改意见】${instruction}`;
}

/**
 * 问一次人（画布审批门）。
 * 语义：**只点「通过」即可；想写意见才写**；点「拒绝」/跳过 = 拒绝。
 * @returns {Promise<{approved: boolean, instruction: string, selected: string[]}>}
 */
async function askApprovalGate({ userQuestions, parent, runId, gate, checkpoint, index, total, controller }) {
  const APPROVE = '通过';
  const REJECT = '拒绝';
  broadcast(runId, 'canvas/approval', {
    state: 'waiting',
    note: gate.note,
    nodeId: gate.id,
    index,
    total,
    preview: summarizeValue(checkpoint),
  });
  // ⚠️ 这里**故意不加** `intent: { kind: 'plan-review' }`：
  //    加了会把提问绑到 DSH 的「计划审批」流程上（卡片变成「要求修改 / 同意执行」、
  //    会话标成「计划待审」），而那个流程有自己的生命周期，会把我们的提问**取消掉**
  //    → 实测报 `the user canceled ask_user_question`。用普通问题卡片即可：
  //    两个选项（通过/拒绝）+ 自由文字框，正好是"点通过就行、想写意见才写"。
  let answer;
  try {
    answer = await userQuestions.ask({
      questions: [
        {
          id: 'canvas-approval',
          header: total > 1 ? `画布审批（第 ${index}/${total} 关）` : '画布审批',
          question: gate.note,
          detail: summarizeValue(checkpoint),
          options: [{ label: APPROVE }, { label: REJECT }],
        },
      ],
      agent: parent,
      signal: controller?.signal,
    });
  } catch (err) {
    const why = String(err?.message ?? err);
    broadcast(runId, 'canvas/approval', {
      state: 'rejected',
      note: gate.note,
      nodeId: gate.id,
      index,
      total,
      selected: [],
      instruction: '',
      error: why,
      preview: summarizeValue(checkpoint),
    });
    throw new Error(
      `第 ${index}/${total} 关审批没能问出来（${why}）。如果是误触/关掉了卡片，重新点「▶ 运行」即可`,
    );
  }
  const item = (answer?.answers ?? []).find((a) => a && a.id === 'canvas-approval');
  const selected = Array.isArray(item?.selected) ? item.selected : [];
  const instruction = typeof item?.custom === 'string' ? item.custom.trim() : '';
  const rejected = selected.includes(REJECT);
  const approved = !rejected && (selected.includes(APPROVE) || instruction !== '');
  broadcast(runId, 'canvas/approval', {
    state: approved ? 'approved' : 'rejected',
    note: gate.note,
    nodeId: gate.id,
    index,
    total,
    selected,
    instruction,
    preview: summarizeValue(checkpoint),
  });
  return { approved, instruction, selected };
}

/**
 * 多层长链：按 N 个审批门依次「跑一段 → 问一次人」，每关的意见拼进下一段输入。
 * 与单门版走同一条执行路线（`tools.execute` 借道 workflow 工具），只是循环。
 */
async function handleRunWithApprovals(ctx, body, state, approvalIds) {
  const tools = ctx.get('tools');
  const agents = ctx.get('agents');
  const userQuestions = ctx.get('userQuestions');

  if (typeof tools?.execute !== 'function') {
    return { status: 503, data: { ok: false, error: 'tools.execute 不可用，没法跑工作流' } };
  }
  if (!userQuestions || typeof userQuestions.ask !== 'function') {
    return { status: 503, data: { ok: false, error: 'userQuestions 服务不可用 —— 本内核版本可能不支持人工审批' } };
  }

  let splits;
  try {
    splits = compileSplits(body.graph, approvalIds);
  } catch (err) {
    return { status: 400, data: { ok: false, error: err?.message ?? String(err), code: 'CANVAS_APPROVAL' } };
  }

  const parent = pickParent(agents, body?.sessionId);
  if (!parent) {
    return { status: 409, data: { ok: false, error: '没有活跃会话可以作为 parent' } };
  }

  const runId = `appr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const controller = new AbortController();
  const mergedLabel = new Map();
  for (const seg of splits.segments) {
    for (const [k, v] of labelIndex(seg)) if (!mergedLabel.has(k)) mergedLabel.set(k, v);
  }
  const allNodeIds = splits.segments
    .flatMap((s) => s.order)
    .filter((x, i, arr) => arr.indexOf(x) === i);

  runs.set(runId, {
    kind: 'approval',
    sessionId: String(parent.id),
    nodeIds: allNodeIds,
    labelToId: mergedLabel,
    controller,
    startedAt: Date.now(),
  });
  // 缩略图靠轮询产物回传文件（工具路线下收不到 workflow 事件）
  startImagePreviewPoll(runId, splits.imageTmp);
  broadcast(runId, 'canvas/queued', {
    sessionId: String(parent.id),
    nodeIds: splits.segments[0].order,
    via: 'approval',
    needApproval: true,
    gates: splits.approvals.length,
  });

  (async () => {
    try {
      let value = null;
      let instruction = '';
      for (let i = 0; i < splits.segments.length; i++) {
        const seg = splits.segments[i];
        broadcast(runId, 'canvas/phase', {
          text: i === 0 ? '第一段执行中（审批之前）' : `第 ${i + 1} 段执行中（审批之后）`,
        });
        const exec = await tools.execute({
          callId: `canvas-appr-${runId}-${i}`,
          name: 'workflow',
          arguments:
            i === 0
              ? { script: seg.script, meta: seg.meta }
              : { script: seg.script, meta: seg.meta, args: { prompt: withInstruction(value, instruction) } },
          agent: parent,
          signal: controller.signal,
        });
        if (exec?.isError === true) throw new Error(`第 ${i + 1} 段执行失败（细节看会话里的工具卡片）`);
        value = exec?.value?.result?.result ?? null;

        if (i >= splits.approvals.length) break; // 已是最后一段

        const gate = splits.approvals[i];
        const res = await askApprovalGate({
          userQuestions,
          parent,
          runId,
          gate,
          checkpoint: value,
          index: i + 1,
          total: splits.approvals.length,
          controller,
        });
        if (!res.approved) {
          broadcast(runId, 'canvas/result', {
            stopReason: 'cancelled',
            error: `第 ${i + 1} 关审批被拒绝`,
            agentsStarted: -1,
            value: { approval: 'rejected', gate: i + 1, checkpoint: value },
          });
          return;
        }
        instruction = res.instruction;
      }

      broadcast(runId, 'canvas/result', {
        stopReason: 'completed',
        error: null,
        agentsStarted: -1,
        value: { approval: 'approved', gates: splits.approvals.length, final: value },
      });
    } catch (err) {
      broadcast(runId, 'canvas/result', {
        stopReason: controller.signal.aborted ? 'cancelled' : 'error',
        error: String(err?.message ?? err),
        agentsStarted: 0,
        value: null,
      });
    } finally {
      runs.delete(runId);
    }
  })();

  return {
    status: 200,
    data: {
      ok: true,
      via: 'approval',
      needApproval: true,
      runId,
      sessionId: String(parent.id),
      gates: splits.approvals.length,
      approvals: splits.approvals,
      order: splits.segments[0].order,
      script: splits.segments[0].script,
    },
  };
}

async function handleRunWithApproval(ctx, body, state, approvalId) {
  const tools = ctx.get('tools');
  const agents = ctx.get('agents');
  const userQuestions = ctx.get('userQuestions');

  if (typeof tools?.execute !== 'function') {
    return { status: 503, data: { ok: false, error: 'tools.execute 不可用，没法跑工作流' } };
  }
  if (!userQuestions || typeof userQuestions.ask !== 'function') {
    return {
      status: 503,
      data: { ok: false, error: 'userQuestions 服务不可用 —— 本内核版本可能不支持人工审批' },
    };
  }

  let split;
  try {
    split = compileSplit(body.graph, approvalId);
  } catch (err) {
    return { status: 400, data: { ok: false, error: err?.message ?? String(err), code: 'CANVAS_APPROVAL' } };
  }

  const parent = pickParent(agents, body?.sessionId);
  if (!parent) {
    return { status: 409, data: { ok: false, error: '没有活跃会话可以作为 parent' } };
  }

  const runId = `appr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const controller = new AbortController();
  runs.set(runId, {
    kind: 'approval',
    sessionId: String(parent.id),
    nodeIds: split.pre.order,
    controller,
    startedAt: Date.now(),
  });
  // 缩略图靠轮询产物回传文件（工具路线下收不到 workflow 事件）
  startImagePreviewPoll(runId, split.imageTmp);
  broadcast(runId, 'canvas/queued', {
    sessionId: String(parent.id),
    nodeIds: split.pre.order,
    via: 'approval',
    needApproval: true,
  });

  // 后台推进（审批可能等几小时，HTTP 不能挂）
  (async () => {
    try {
      // ── 段 1 ──
      broadcast(runId, 'canvas/phase', { text: '第一段执行中（审批之前）' });
      const preExec = await tools.execute({
        callId: `canvas-appr-pre-${runId}`,
        name: 'workflow',
        arguments: { script: split.pre.script, meta: split.pre.meta },
        agent: parent,
        signal: controller.signal,
      });
      if (preExec?.isError === true) throw new Error('第一段执行失败（细节看会话里的工具卡片）');
      const preScriptResult = preExec?.value?.result;
      const checkpoint = preScriptResult?.result ?? null;

      // ── 问人 ──（与多门版共用同一个 askApprovalGate，语义完全一致）
      const gateRes = await askApprovalGate({
        userQuestions,
        parent,
        runId,
        gate: split.approval,
        checkpoint,
        index: 1,
        total: 1,
        controller,
      });
      const approved = gateRes.approved;
      const instruction = gateRes.instruction;

      if (!approved) {
        broadcast(runId, 'canvas/result', {
          stopReason: 'cancelled',
          error: '审批被拒绝',
          agentsStarted: -1,
          value: { approval: 'rejected', checkpoint },
        });
        return;
      }

      // ── 段 2（起点 = 段1 的结果）──
      broadcast(runId, 'canvas/phase', { text: '第二段执行中（审批之后）' });
      const postExec = await tools.execute({
        callId: `canvas-appr-post-${runId}`,
        name: 'workflow',
        arguments: {
          script: split.post.script,
          meta: split.post.meta,
          args: {
            prompt: instruction === ''
              ? checkpoint
              : `${typeof checkpoint === 'string' ? checkpoint : JSON.stringify(checkpoint)}\n\n【主人的修改意见】${instruction}`,
          },
        },
        agent: parent,
        signal: controller.signal,
      });
      if (postExec?.isError === true) throw new Error('第二段执行失败（细节看会话里的工具卡片）');
      const postScriptResult = postExec?.value?.result;

      broadcast(runId, 'canvas/result', {
        stopReason: 'completed',
        error: null,
        agentsStarted: -1,
        value: {
          approval: 'approved',
          checkpoint,
          post: postScriptResult?.result ?? null,
        },
      });
    } catch (err) {
      broadcast(runId, 'canvas/result', {
        stopReason: controller.signal.aborted ? 'cancelled' : 'error',
        error: String(err?.message ?? err),
        agentsStarted: 0,
        value: null,
      });
    } finally {
      runs.delete(runId);
    }
  })();

  return {
    status: 200,
    data: {
      ok: true,
      via: 'approval',
      needApproval: true,
      runId,
      sessionId: String(parent.id),
      approval: split.approval,
      order: split.pre.order,
      script: split.pre.script,
    },
  };
}

async function handleRun(ctx, body, state) {
  // 图里有审批节点 → 走「拆段 + 问人」那条路。
  // 1 个门：走原来的单门版（行为零改动）；**多个门：走多层长链版**（P0-6）。
  const approvalNodes = (Array.isArray(body?.graph?.nodes) ? body.graph.nodes : []).filter(
    (n) => n && n.type === 'approval',
  );
  if (approvalNodes.length > 1) {
    return handleRunWithApprovals(ctx, body, state, approvalNodes.map((n) => n.id));
  }
  if (approvalNodes.length === 1) {
    return handleRunWithApproval(ctx, body, state, approvalNodes[0].id);
  }

  const agents = ctx.get('agents');
  const tools = ctx.get('tools');
  const workflowEngine = state?.engine ?? ctx.get('workflowEngine');
  const hasEngine = typeof workflowEngine?.start === 'function';
  const hasTools = typeof tools?.execute === 'function';

  if (typeof agents?.get !== 'function') {
    return { status: 503, data: { ok: false, error: 'agents 服务不可用' } };
  }
  if (!hasEngine && !hasTools) {
    return {
      status: 503,
      data: { ok: false, error: '既拿不到 workflowEngine，也没有可用的 tools.execute —— 没法起工作流' },
    };
  }

  let compiled;
  try {
    compiled = compile(body?.graph);
  } catch (err) {
    return {
      status: 400,
      data: { ok: false, error: err?.message ?? String(err), code: err?.code ?? 'CANVAS_COMPILE' },
    };
  }

  const parent = pickParent(agents, body?.sessionId);
  if (!parent) {
    return { status: 409, data: { ok: false, error: '没有活跃会话可以作为 parent（先在这个页面开一个会话）' } };
  }

  const maxTotalAgents = Number.isFinite(body?.maxTotalAgents) ? Number(body.maxTotalAgents) : 8;

  // ── 路线 B：拿不到引擎服务时，借全局的 `tools` 服务执行内核的 workflow 工具 ──
  // 引擎（workflow-worker-thread）被关在**每个 agent 会话自己的 realm** 里，realm 外的
  // 插件既 `ctx.get` 不到、`inject` 也等不到；但 `tools` 是全局服务，而 workflow 工具
  // 本身就在那个 realm 内注册 —— 于是"借道工具"就能把脚本送进引擎。
  // 代价：拿不到 run 句柄 → 只能等最终结果（实时高亮仍指望 workflow/* 事件）。
  if (!hasEngine) {
    const runId = `tool-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const callId = `canvas-${runId}`;
    const controller = new AbortController();

    // ── 逐节点进度：轮询全局的 `subagents` ──
    // 内核的 `workflow/*` 事件在 **agent realm 内** emit，realm 外收不到（实测一条都没有），
    // 所以改用**全局可见**的 subagents 服务做替代信号：`listChildren` 给出每个子代理的
    // `label`（正是我们在脚本里传给 `agent()` 的节点名）和 `activity`(running/inactive)。
    const subagents = ctx.get('subagents');
    let pollTimer = null;
    let pollFailures = 0;
    const pollDeadline = Date.now() + 10 * 60 * 1000; // 10 分钟保险丝
    const stopPoll = () => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    runs.set(runId, {
      kind: 'tool',
      sessionId: String(parent.id),
      nodeIds: compiled.order,
      labelToId: labelIndex(compiled),
      controller,
      stopPoll,
      startedAt: Date.now(),
    });
    startImagePreviewPoll(runId, compiled.imageTmp);
    broadcast(runId, 'canvas/queued', {
      sessionId: String(parent.id),
      nodeIds: compiled.order,
      via: 'tools.execute',
      polling: Boolean(subagents && typeof subagents.listChildren === 'function'),
    });

    if (subagents && typeof subagents.listChildren === 'function') {
      const tick = async () => {
        if (Date.now() > pollDeadline) {
          broadcast(runId, 'canvas/nodes', { nodes: [], note: '轮询超时已停（10 分钟）' });
          return;
        }
        try {
          const list = await subagents.listChildren(parent.id);
          const nodes = [];
          for (const entry of list) {
            if (!entry || entry.kind !== 'child') continue;
            nodes.push({
              label: entry.label === undefined ? '' : String(entry.label),
              childId: String(entry.id),
              status: entry.activity === 'running' ? 'running' : 'done',
            });
          }
          broadcast(runId, 'canvas/nodes', { nodes });
        } catch (err) {
          // 一次轮询失败不影响流程，但**不能悄悄吞掉** —— 否则"节点不亮"时无从排查。
          // 限流：每 20 次最多记一条。
          pollFailures += 1;
          if (pollFailures % 20 === 1) {
            ctx.logger?.warn?.(`[canvas] 子代理轮询失败（第 ${pollFailures} 次）：${err?.message ?? err}`);
          }
        }
        pollTimer = setTimeout(tick, 900);
      };
      pollTimer = setTimeout(tick, 500);
    }

    Promise.resolve()
      .then(() =>
        tools.execute({
          callId,
          name: 'workflow',
          arguments: { script: compiled.script, meta: compiled.meta },
          agent: parent,
          signal: controller.signal,
        }),
      )
      .then((result) => {
        let value = null;
        try {
          value = result && typeof result === 'object' ? (result.value === undefined ? result : result.value) : null;
        } catch {
          value = null;
        }
        broadcast(runId, 'canvas/result', {
          stopReason: result?.isError === true ? 'error' : 'completed',
          error: result?.isError === true ? '工具返回了 error（细节看会话里的工具卡片）' : null,
          agentsStarted: -1,
          value,
        });
      })
      .catch((err) => {
        broadcast(runId, 'canvas/result', {
          stopReason: controller.signal.aborted ? 'cancelled' : 'error',
          error: String(err?.message ?? err),
          agentsStarted: 0,
          value: null,
        });
      })
      .finally(() => {
        stopPoll();
        runs.delete(runId);
      });

    return {
      status: 200,
      data: {
        ok: true,
        via: 'tools.execute',
        runId,
        sessionId: String(parent.id),
        meta: compiled.meta,
        warnings: compiled.warnings,
        order: compiled.order,
        script: compiled.script,
      },
    };
  }

  let run;
  try {
    run = workflowEngine.start({
      script: compiled.script,
      meta: compiled.meta,
      parent,
      maxTotalAgents,
    });
  } catch (err) {
    return { status: 400, data: { ok: false, error: `引擎拒绝启动：${err?.message ?? err}` } };
  }

  const runId = String(run.id);
  const nodeIds = compiled.order;
  runs.set(runId, { run, sessionId: String(parent.id), nodeIds, labelToId: labelIndex(compiled), startedAt: Date.now() });
  broadcast(runId, 'canvas/queued', { sessionId: String(parent.id), nodeIds });

  // 结果落地（result 永不 reject）
  run.result
    .then((result) => {
      broadcast(runId, 'canvas/result', {
        stopReason: result?.stopReason ?? 'unknown',
        error: result?.error ?? null,
        agentsStarted: result?.agentsStarted ?? 0,
        value: result?.stopReason === 'completed' ? (result.value ?? null) : null,
      });
    })
    .catch((err) => {
      broadcast(runId, 'canvas/result', { stopReason: 'error', error: String(err?.message ?? err), agentsStarted: 0, value: null });
    })
    .finally(() => {
      runs.delete(runId);
    });

  return {
    status: 200,
    data: {
      ok: true,
      runId,
      sessionId: String(parent.id),
      meta: compiled.meta,
      warnings: compiled.warnings,
      order: nodeIds,
      script: compiled.script,
    },
  };
}

// ─────────────────────────── 挂载 ───────────────────────────

export function apply(ctx) {
  // 兜底：挂载失败只让本插件失效，绝不拖累整棵插件树
  try {
    mount(ctx);
  } catch (err) {
    ctx.logger?.warn?.(`[canvas] 挂载失败（不影响其他插件）：${err?.message ?? err}`);
  }
}

function mount(ctx) {
  /** 引擎就绪状态（第二层 inject 的回调里置位）。 */
  const state = { engineReady: false, engine: null };

  // ── 产物定时清理（不依赖任何服务；`DSH_CANVAS_IMAGE_TTL_DAYS=0` 可关）──
  // 只清画布自己的产物目录 + `%TEMP%/canvas-img-*`，**绝不碰主人的图库**。
  if (IMAGE_TTL_DAYS > 0) {
    const sweep = (why) => {
      try {
        const images = cleanupOldImages(path.join(DATA_DIR, 'images'), IMAGE_TTL_DAYS * 86400000);
        const tmp = cleanupCanvasTmp(24 * 3600 * 1000);
        if (images.deleted > 0 || tmp.deleted > 0) {
          ctx.logger?.info?.(
            `[canvas] ${why}清理：产物图 ${images.deleted} 个 / ${(images.bytes / 1048576).toFixed(1)}MB，临时文件 ${tmp.deleted} 个`,
          );
        }
      } catch (err) {
        ctx.logger?.warn?.(`[canvas] 产物清理失败：${err?.message ?? err}`);
      }
    };
    const first = setTimeout(() => sweep('启动'), 30000);
    const every = setInterval(() => sweep('定时'), 6 * 3600 * 1000);
    if (typeof first.unref === 'function') first.unref();
    if (typeof every.unref === 'function') every.unref();
    ctx.effect(
      () => () => {
        clearTimeout(first);
        clearInterval(every);
      },
      'canvas: 产物清理计时器',
    );
  }

  // ── 第一层：只依赖 webServer → 基础路由永远挂得上 ──
  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[canvas] webServer 不可用，未挂载任何路由');
      return;
    }

    // ⚠️ 引擎（workflowEngine）在 0.1.2 里被关在 **agent 会话自己的 realm** 内，全局插件拿不到
    //（详见文件头）。但**路由绝不能跟着引擎一起陪葬** —— 否则 run/stop/events 直接 401。
    // 所以这一段**无条件执行**：引擎能拿到就优先用它，拿不到就走路线 B（tools.execute）。
    state.engine = ctx.get('workflowEngine') ?? null;
    state.engineReady = typeof state.engine?.start === 'function';
    if (state.engineReady) ctx.logger?.info?.('[canvas] workflowEngine 可用，将优先走引擎直连');

    {
      const engineRoutes = [
        {
          kind: 'exact',
          path: `${BASE}/run`,
          handler: async (req, res) => {
            try {
              const body = await readJson(req);
              const out = await handleRun(ctx, body, state);
              sendJson(res, out.status, out.data);
            } catch (err) {
              sendJson(res, Number(err?.statusCode) || 500, { ok: false, error: err?.message ?? String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/stop`,
          handler: async (req, res) => {
            try {
              const body = await readJson(req);
              const runId = String(body?.runId ?? '');
              const entry = runs.get(runId);
              if (!entry) {
                sendJson(res, 404, { ok: false, error: `没有正在跑的 runId：${runId}` });
                return;
              }
              if (entry.kind === 'tool' || entry.kind === 'approval') {
                if (typeof entry.stopPoll === 'function') entry.stopPoll();
                entry.controller.abort();
              } else {
                entry.run.cancel('user stopped');
              }
              sendJson(res, 200, { ok: true, runId, cancelled: true });
            } catch (err) {
              sendJson(res, Number(err?.statusCode) || 500, { ok: false, error: err?.message ?? String(err) });
            }
          },
        },
        {
          kind: 'exact',
          path: `${BASE}/events`,
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const runId = url.searchParams.get('runId');
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            });
            res.write(': dsh-canvas events\n\n');
            // 补发最近事件（断线重连/刷新页面用）
            for (const frame of recent) {
              if (runId !== null && frame.runId !== runId) continue;
              res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`);
            }
            const client = { res, runId };
            sseClients.add(client);
            req.on('close', () => {
              sseClients.delete(client);
            });
          },
        },
        {
          /**
           * 外部推进度（**对话模式**）：让「在对话框里干活的 agent / skill」把过程投到画布上。
           *
           * body 三种：
           *   · `{ action:'start', title?, nodes:[{id,label,type?}] }` → 建一次外部运行，广播节点表
           *   · `{ action:'node', runId, nodeId, state, detail?, preview? }` → 点亮 / 贴缩略图
           *   · `{ action:'end', runId, stopReason?, value?, error? }` → 收尾（结果面板）
           *
           * ⚠️ 这是**自注册路由 = 免鉴权**（和 /asset 一样）。它只能"往画布推显示"：
           *    不能读文件、不能执行东西；缩略图仍要走 /asset 的白名单。
           *    仅因 DSH 只监听回环才安全 —— 要开公网/局域网请先给它加闸。
           */
          kind: 'exact',
          path: `${BASE}/report`,
          handler: async (req, res) => {
            try {
              const body = await readJson(req);
              const action = String(body?.action ?? (Array.isArray(body?.nodes) ? 'start' : 'node'));

              if (action === 'start') {
                const rawNodes = Array.isArray(body?.nodes) ? body.nodes : [];
                if (rawNodes.length === 0) {
                  sendJson(res, 400, { ok: false, error: 'nodes 不能为空' });
                  return;
                }
                const title =
                  typeof body?.title === 'string' && body.title.trim() !== '' ? body.title.trim() : '对话模式运行';
                const runId =
                  typeof body?.runId === 'string' && body.runId !== ''
                    ? body.runId
                    : `ext-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
                const nodes = rawNodes.map((n, i) => {
                  const id = String(n?.id ?? `n${i + 1}`);
                  const type = NODE_TYPES.has(String(n?.type)) ? String(n.type) : 'agent';
                  return {
                    id,
                    type,
                    position: { x: 40 + i * 240, y: 240 },
                    data: {
                      label: String(n?.label ?? id),
                      prompt: typeof n?.detail === 'string' ? n.detail : '',
                    },
                  };
                });
                externalRuns.set(runId, { title, nodeIds: nodes.map((n) => n.id), startedAt: Date.now() });
                broadcast(runId, 'canvas/external', { nodes, title });
                broadcast(runId, 'canvas/queued', {
                  sessionId: null,
                  nodeIds: nodes.map((n) => n.id),
                  via: 'external',
                  title,
                });
                sendJson(res, 200, { ok: true, runId, nodeIds: nodes.map((n) => n.id), title });
                return;
              }

              if (action === 'node') {
                const runId = String(body?.runId ?? '');
                const nodeId = body?.nodeId === undefined || body.nodeId === null ? null : String(body.nodeId);
                const ALLOWED = ['pending', 'running', 'waiting', 'done', 'failed'];
                const state = ALLOWED.includes(String(body?.state)) ? String(body.state) : 'running';
                const previewPath =
                  typeof body?.preview === 'string' && body.preview.trim() !== '' ? body.preview.trim() : null;
                broadcast(runId, 'canvas/node', {
                  nodeId,
                  label: body?.label === undefined ? null : String(body.label),
                  state,
                  detail: body?.detail === undefined ? null : String(body.detail),
                  preview: previewPath === null ? null : { kind: 'image', path: previewPath },
                  source: 'external',
                });
                sendJson(res, 200, { ok: true, runId, nodeId, state });
                return;
              }

              if (action === 'end' || action === 'done') {
                const runId = String(body?.runId ?? '');
                externalRuns.delete(runId);
                broadcast(runId, 'canvas/result', {
                  stopReason: String(body?.stopReason ?? 'completed'),
                  error: body?.error === undefined ? null : body.error,
                  agentsStarted: -1,
                  value: body?.value === undefined ? null : body.value,
                });
                sendJson(res, 200, { ok: true, runId });
                return;
              }

              sendJson(res, 400, { ok: false, error: `未知 action：${action}（可用 start / node / end）` });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
            }
          },
        },
        {
          /**
           * 「在资源管理器里显示这个文件」—— 浏览器做不到，只能 host 代劳。
           * 安全：**只允许白名单目录里的图片**（和 /asset 同一套判定），不存在就 404。
           */
          kind: 'exact',
          path: `${BASE}/reveal`,
          handler: async (req, res) => {
            try {
              const body = await readJson(req);
              const raw = String(body?.path ?? '');
              if (raw === '') {
                sendJson(res, 400, { ok: false, error: '缺 path 参数' });
                return;
              }
              const checked = checkAssetPath(raw);
              if (!checked.ok) {
                sendJson(res, checked.status, { ok: false, error: checked.error });
                return;
              }
              if (process.platform !== 'win32') {
                sendJson(res, 501, { ok: false, error: '只有 Windows 支持这一步' });
                return;
              }
              const child = spawn('explorer.exe', [`/select,${checked.path}`], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              });
              child.unref();
              sendJson(res, 200, { ok: true, path: checked.path });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
            }
          },
        },
        {
          // 手动清一次产物（画布自己的目录 + 临时文件）。默认 7 天，body 可传 ttlDays 覆盖。
          // 安全：只动 `DATA_DIR/images` 与 `%TEMP%/canvas-img-*`，绝不碰主人的图库
          //      （`D:\dsh-media\images` 不在清理范围内）。
          kind: 'exact',
          path: `${BASE}/cleanup`,
          handler: async (req, res) => {
            try {
              const body = await readJson(req).catch(() => ({}));
              const raw = Number(body?.ttlDays);
              // 下限 1 天：不给"传个 0 就把产物一次清空"的机会（自动清理用 env 关闭）
              const ttlDays = Number.isFinite(raw) ? Math.max(1, raw) : Math.max(1, IMAGE_TTL_DAYS);
              const imageDir = path.join(DATA_DIR, 'images');
              const images = cleanupOldImages(imageDir, ttlDays * 86400000);
              const tmp = cleanupCanvasTmp(24 * 3600 * 1000);
              sendJson(res, 200, {
                ok: true,
                ttlDays,
                imageDir,
                images,
                tmp,
              });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
            }
          },
        },
        {
          // 受控图片读取：给画布贴缩略图用（浏览器加载不了本地路径）。
          // 安全：① 只读白名单目录（realpath 解析后再比对，防符号链接穿越）
          //       ② 只允许图片扩展名 ③ 只读文件、不写
          kind: 'exact',
          path: `${BASE}/asset`,
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1');
              const raw = url.searchParams.get('path') ?? '';
              if (raw === '') {
                sendJson(res, 400, { ok: false, error: '缺 path 参数' });
                return;
              }
              const checked = checkAssetPath(raw);
              if (!checked.ok) {
                sendJson(res, checked.status, { ok: false, error: checked.error });
                return;
              }
              const buf = fs.readFileSync(checked.path);
              res.writeHead(200, {
                'content-type': checked.type,
                'content-length': buf.length,
                'cache-control': 'no-store',
              });
              res.end(buf);
            } catch (err) {
              sendJson(res, 404, { ok: false, error: `读不到这个文件：${err?.message ?? String(err)}` });
            }
          },
        },
      ];

      for (const route of engineRoutes) {
        ctx.effect(() => webServer.register(route), `canvas: ${route.path}`);
      }

      // workflow 事件 → SSE
      const relay = (event, build) => (info, extra) => {
        const runId = String(info?.id ?? '');
        broadcast(runId, event, build(extra));
      };
      ctx.on(
        'workflow/start',
        relay('workflow/start', () => ({})),
      );
      ctx.on(
        'workflow/phase',
        (info, extra) => {
          const runId = String(info?.id ?? '');
          const title = typeof extra === 'string' ? extra : String(extra ?? '');
          broadcast(runId, 'workflow/phase', { phase: title });
          // 每个节点都会 phase()，所以这条能把**所有节点类型**（含 image/condition/parallel/output）
          // 的「开始运行」都还原成稳定 nodeId 发给前端。
          const nodeId = nodeIdOf(runId, title);
          if (nodeId !== null) {
            broadcast(runId, 'canvas/node', { nodeId, label: title, state: 'running', source: 'phase' });
          }
        },
      );
      ctx.on(
        'workflow/log',
        (info, extra) => {
          const runId = String(info?.id ?? '');
          const message = typeof extra === 'string' ? extra : String(extra ?? '');
          // 图像节点的产物回传：转成 canvas/node + preview（缩略图走 /asset），
          // **不把这行内部标记吐给用户**。
          if (message.startsWith(IMAGE_MARK)) {
            let nodeId = null;
            let raw = '';
            try {
              const payload = JSON.parse(message.slice(IMAGE_MARK.length));
              nodeId = payload?.nodeId === undefined ? null : String(payload.nodeId);
              raw = payload?.raw === undefined || payload?.raw === null ? '' : String(payload.raw);
            } catch {
              /* 解析失败就退化成普通日志（下面继续走 workflow/log） */
            }
            const meta = parseImageMeta(raw);
            const imagePath =
              (meta && typeof meta.path === 'string' ? meta.path : null) || findImagePath(raw);
            if (nodeId !== null || imagePath !== null) {
              broadcast(runId, 'canvas/node', {
                nodeId,
                state: imagePath === null ? 'failed' : 'done',
                preview: imagePath === null ? null : { kind: 'image', path: imagePath },
                detail: imagePath === null ? '图像节点没能给出产物路径' : describeImageMeta(meta, imagePath),
                meta,
                source: 'image-node',
              });
              return;
            }
          }
          broadcast(runId, 'workflow/log', { message });
        },
      );
      ctx.on(
        'workflow/agent-start',
        (info, extra) => {
          const runId = String(info?.id ?? '');
          const a = extra ?? {};
          const label = String(a?.label ?? '');
          const nodeId = nodeIdOf(runId, label);
          broadcast(runId, 'workflow/agent-start', {
            seq: Number(a?.seq ?? 0),
            label,
            nodeId,
            phase: a?.phase === undefined ? null : String(a.phase),
            childId: String(a?.childId ?? ''),
          });
          broadcast(runId, 'canvas/node', { nodeId, label, state: 'running', source: 'agent-start' });
        },
      );
      ctx.on(
        'workflow/agent-end',
        (info, extra) => {
          const runId = String(info?.id ?? '');
          const a = extra ?? {};
          const label = String(a?.label ?? '');
          const nodeId = nodeIdOf(runId, label);
          const outcome = String(a?.outcome ?? 'unknown');
          broadcast(runId, 'workflow/agent-end', {
            seq: Number(a?.seq ?? 0),
            label,
            nodeId,
            outcome,
            childId: String(a?.childId ?? ''),
          });
          broadcast(runId, 'canvas/node', {
            nodeId,
            label,
            state: outcome === 'completed' || outcome === 'success' ? 'done' : outcome === 'cancelled' ? 'pending' : 'failed',
            outcome,
            source: 'agent-end',
          });
        },
      );
      ctx.on(
        'workflow/end',
        relay('workflow/end', (r) => ({
          stopReason: String(r?.stopReason ?? 'unknown'),
          error: r?.error === undefined ? null : String(r.error),
          agentsStarted: Number(r?.agentsStarted ?? 0),
        })),
      );

      ctx.logger?.info?.(
        `[canvas] 运行路由已挂载：${BASE}/{run,stop,events} + 6 个 workflow/* 事件（引擎=${state.engineReady ? '直连' : 'tools.execute'}）`,
      );
    }

    const routes = [
      {
        kind: 'exact',
        path: `${BASE}/probe`,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          sendJson(res, 200, probe(ctx, url.searchParams.get('sessionId'), state));
        },
      },
      {
        kind: 'exact',
        path: PROBE_ALIAS,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          sendJson(res, 200, probe(ctx, url.searchParams.get('sessionId'), state));
        },
      },
      {
        kind: 'exact',
        path: `${BASE}/compile`,
        handler: async (req, res) => {
          try {
            const body = await readJson(req);
            const compiled = compile(body?.graph);
            sendJson(res, 200, {
              ok: true,
              meta: compiled.meta,
              warnings: compiled.warnings,
              order: compiled.order,
              script: compiled.script,
            });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err?.message ?? String(err), code: err?.code ?? 'CANVAS_COMPILE' });
          }
        },
      },
      {
        kind: 'exact',
        path: `${BASE}/graphs`,
        handler: (_req, res) => {
          try {
            const dir = graphDir();
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
            const items = files.map((f) => {
              let stat = null;
              try {
                stat = fs.statSync(path.join(dir, f));
              } catch {
                stat = null;
              }
              return { name: f.replace(/\.json$/, ''), file: f, bytes: stat?.size ?? 0, at: stat?.mtimeMs ?? 0 };
            });
            items.sort((a, b) => b.at - a.at);
            sendJson(res, 200, { ok: true, dir, count: items.length, items });
          } catch (err) {
            sendJson(res, Number(err?.statusCode) || 500, { ok: false, error: err?.message ?? String(err) });
          }
        },
      },
      {
        kind: 'exact',
        path: `${BASE}/graph`,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1');
              const nm = graphFileName(url.searchParams.get('name'));
              if (nm === '') {
                sendJson(res, 400, { ok: false, error: '缺少 name 参数' });
                return;
              }
              const full = path.join(graphDir(), `${nm}.json`);
              if (!fs.existsSync(full)) {
                sendJson(res, 404, { ok: false, error: `没有这个画布：${nm}` });
                return;
              }
              sendJson(res, 200, { ok: true, name: nm, graph: JSON.parse(fs.readFileSync(full, 'utf8')) });
              return;
            }
            const body = await readJson(req);
            // ⚠️ 名字被过滤成空（中文名会全被滤掉）时**不能**回落时间戳 ——
            // 那会让同一张图每次存成新文件、原文件永远覆盖不到（独立审查实测）。
            // 改成用**内容摘要**：同一张图永远落到同一个文件。
            let nm = graphFileName(body?.name ?? body?.graph?.name ?? '');
            if (nm === '') {
              const payload = JSON.stringify(body?.graph ?? {});
              let h = 5381;
              for (let i = 0; i < payload.length; i++) h = ((h * 33) ^ payload.charCodeAt(i)) >>> 0;
              nm = `canvas_${h.toString(36)}`;
            }
            const full = path.join(graphDir(), `${nm}.json`);
            fs.writeFileSync(full, JSON.stringify(body?.graph ?? {}, null, 2), 'utf8');
            sendJson(res, 200, { ok: true, name: nm, file: full });
          } catch (err) {
            sendJson(res, Number(err?.statusCode) || 500, { ok: false, error: err?.message ?? String(err) });
          }
        },
      },
      {
        kind: 'exact',
        path: `${BASE}/generate`,
        handler: async (req, res) => {
          try {
            const body = await readJson(req);
            const spec = String(body?.spec ?? '').trim();
            if (spec === '') {
              sendJson(res, 400, { ok: false, error: '缺少 spec：告诉我你想要的流程是什么' });
              return;
            }
            const agents = ctx.get('agents');
            const tools = ctx.get('tools');
            if (typeof tools?.execute !== 'function') {
              sendJson(res, 503, { ok: false, error: 'tools.execute 不可用，没法问 AI' });
              return;
            }
            const parent = pickParent(agents, body?.sessionId);
            if (!parent) {
              sendJson(res, 409, { ok: false, error: '没有活跃会话可以作为 parent' });
              return;
            }

            // 借道内核的 workflow 工具问一次 AI（和画布运行走同一条路）
            const controller = new AbortController();
            const result = await tools.execute({
              callId: `canvas-gen-${Date.now().toString(36)}`,
              name: 'workflow',
              arguments: {
                script: buildGenerateScript(),
                meta: { name: 'canvas-generate', description: '把一句话需求翻译成画布图 JSON' },
                args: { spec, instructions: GENERATE_SYSTEM },
              },
              agent: parent,
              signal: controller.signal,
            });

            if (result && result.isError === true) {
              sendJson(res, 502, { ok: false, error: '生成用的子代理执行失败（细节看会话里的工具卡片）' });
              return;
            }

            const rawText = pickGeneratedText(result);
            const parsed = extractGraph(rawText);
            const graph = normalizeGraph(parsed);
            // 生成的图必须真能编译 —— 不然用户点了运行才知道坏，太晚
            compile(graph);

            sendJson(res, 200, { ok: true, graph, raw: rawText.slice(0, 4000) });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err?.message ?? String(err), code: err?.code ?? 'CANVAS_GENERATE' });
          }
        },
      },
      {
        kind: 'exact',
        path: `${BASE}/graph/delete`,
        handler: async (req, res) => {
          try {
            const body = await readJson(req);
            const nm = graphFileName(body?.name);
            if (nm === '') {
              sendJson(res, 400, { ok: false, error: '缺少 name 参数' });
              return;
            }
            // safeIdent 已经滤掉路径分隔符；这里再确认一次最终路径没跑出画布目录
            const dir = graphDir();
            const full = path.join(dir, `${nm}.json`);
            if (!full.startsWith(dir)) {
              sendJson(res, 400, { ok: false, error: '非法的名字' });
              return;
            }
            if (!fs.existsSync(full)) {
              sendJson(res, 404, { ok: false, error: `没有这个画布：${nm}` });
              return;
            }
            fs.unlinkSync(full);
            sendJson(res, 200, { ok: true, name: nm, deleted: true });
          } catch (err) {
            sendJson(res, Number(err?.statusCode) || 500, { ok: false, error: err?.message ?? String(err) });
          }
        },
      },
    ];

    for (const route of routes) {
      ctx.effect(() => webServer.register(route), `canvas: ${route.path}`);
    }

    ctx.logger?.info?.(`[canvas] 基础路由已挂载（${routes.length} 条）+ 免鉴权探针 ${PROBE_ALIAS}`);
  });
}
