/**
 * dsh-canvas 离线验收 —— **不重启 DSH 就能跑**的硬验证。
 *
 * 查三件事：
 *   1) compile() 的编译产物**语义对不对** —— 用假的 agent()/phase()/log() 真跑一遍脚本；
 *   2) 非法画布（有环 / 未知类型 / 缺节点 / 悬空引用）是否按预期报 CanvasError；
 *   3) host 半边 apply() 用假 ctx 能否正常挂载
 *      —— 挡掉"重启后整棵插件树 apply 失败、DSH 起不来"的风险。
 *
 * 用法：node ~/.dsh/plugins/dsh-canvas/verify-offline.mjs
 */
import { compile, compileSplit, CanvasError } from './lib/index.js';
import { extractGraph, normalizeGraph, buildGenerateScript, GENERATE_SYSTEM } from './lib/generate.js';
import * as mod from './lib/index.js';
import vm from 'node:vm';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  \u2713 ' + name);
  } else {
    failures.push(name + (extra ? ' \u2014 ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + extra : ''));
  }
}

/** 断言某次调用抛出 CanvasError（且 message 含 needle）。 */
function throwsCanvas(name, fn, needle) {
  try {
    fn();
    failures.push(name + ' \u2014 没有抛错');
    console.log('  \u2717 ' + name + '（没有抛错）');
  } catch (err) {
    const msg = String((err && err.message) || err);
    const isCanvas = err instanceof CanvasError;
    const hasText = !needle || msg.includes(needle);
    if (isCanvas && hasText) {
      pass += 1;
      console.log('  \u2713 ' + name);
    } else {
      failures.push(name + ' \u2014 ' + msg);
      console.log('  \u2717 ' + name + ' \u2014 ' + msg);
    }
  }
}



/**
 * 复刻内核 workflow 引擎的返回值检查：**必须是纯 JSON**。
 * undefined / function / 循环引用都会当场炸 —— 真机上就是这么报的：
 *   `workflow result.outputs.n6: undefined is not JSON data`
 * 之前的假运行时不做这个检查，所以放过了「分支没跑的那一支」。
 */
function assertJsonValue(value, path) {
  if (value === undefined) throw new Error("not plain JSON: " + path + " is undefined");
  if (typeof value === "function") throw new Error("not plain JSON: " + path + " is a function");
  if (typeof value === "bigint") throw new Error("not plain JSON: " + path + " is a bigint");
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonValue(item, path + "[" + i + "]"));
    return;
  }
  if (typeof value === "object") {
    for (const k of Object.keys(value)) assertJsonValue(value[k], path + "." + k);
  }
}

/** 拿假运行时把编译产物跑起来（正是内核 workflow 引擎给脚本的四个全局）。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runScript(script, args, agentImpl) {
  const calls = [];
  const phases = [];
  const logs = [];
  const fn = new AsyncFunction('agent', 'phase', 'log', 'args', 'parallel', script);
  /** 内核脚本的 parallel 全局：假实现按顺序 await（语义等价，测试够用）。 */
  const parallelImpl = async (thunks) => {
    const out = [];
    for (const t of thunks) out.push(await t());
    return out;
  };
  const value = await fn(
    async (prompt, opts) => {
      calls.push({ prompt: prompt, opts: opts });
      return agentImpl ? agentImpl(prompt, opts) : 'AGENT_OUT';
    },
    (title) => {
      phases.push(title);
    },
    (msg) => {
      logs.push(msg);
    },
    args,
    parallelImpl,
  );
  assertJsonValue(value, "result");
  return { value: value, calls: calls, phases: phases, logs: logs };
}

// ─────────────────────── 1. trigger → agent → output ───────────────────────

const graphA = {
  version: 1,
  name: '小鲸测试流',
  nodes: [
    { id: 'n1', type: 'trigger', position: { x: 80, y: 120 }, data: { prompt: '默认提示词' } },
    { id: 'n2', type: 'agent', position: { x: 320, y: 120 }, data: { prompt: '围绕主题写一句话', label: '写方案' } },
    { id: 'n3', type: 'output', position: { x: 560, y: 120 }, data: {} },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'n3' },
  ],
};

console.log('\n[1] trigger → agent → output');
const compiledA = compile(graphA);
console.log('--- 编译产物 ---');
console.log(compiledA.script);
console.log('--- meta ---');
console.log(JSON.stringify(compiledA.meta, null, 2));

ok('meta.name 被规范成 kebab', compiledA.meta.name === 'canvas-run', compiledA.meta.name);
ok('meta.phases 收录 agent 节点的 label', compiledA.meta.phases && compiledA.meta.phases[0].title === '写方案');
ok('拓扑序 = 三节点顺序', JSON.stringify(compiledA.order) === JSON.stringify(['n1', 'n2', 'n3']), JSON.stringify(compiledA.order));
ok('脚本含 await agent(', compiledA.script.includes('await agent('));

const runA = await runScript(compiledA.script, { prompt: '用一句话介绍你自己' });
ok('运行时真的进了 agent()', runA.calls.length === 1);
ok('agent 收到 label=写方案', runA.calls[0] && runA.calls[0].opts && runA.calls[0].opts.label === '写方案');
ok('trigger 的值来自 args.prompt', runA.calls[0] && runA.calls[0].prompt.includes('用一句话介绍你自己'));
ok('未写 {{引用}} 时自动拼接上游', runA.calls[0] && runA.calls[0].prompt.includes('【上游 n1】'));
ok('phase() 被调用且标题与 meta 一致', runA.phases.length === 1 && runA.phases[0] === '写方案');
ok('return 的 result = agent 输出', runA.value && runA.value.result === 'AGENT_OUT');
ok('return 的 outputs 收到 n2 结果', runA.value && runA.value.outputs && runA.value.outputs.n2 === 'AGENT_OUT');

// ─────────────────────── 2. {{}} 变量引用 ───────────────────────

console.log('\n[2] {{step_x}} 变量引用');
const graphB = {
  version: 1,
  name: 'ref-test',
  nodes: [
    { id: 'a', type: 'trigger', data: { prompt: '默认' } },
    { id: 'b', type: 'agent', data: { prompt: '基于 {{a}} 再写', label: 'B' } },
    { id: 'out', type: 'output', data: {} },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'b', to: 'out' },
  ],
};
const compiledB = compile(graphB);
const runB = await runScript(compiledB.script, { prompt: '起点' });
ok('{{a}} 被替换成上游真实值', runB.calls[0] && runB.calls[0].prompt.indexOf('基于 起点 再写') === 0, runB.calls[0] && runB.calls[0].prompt);
ok('写了引用就不再重复拼接上游', runB.calls[0] && !runB.calls[0].prompt.includes('【上游'));

// ─────────────────────── 3. 非法图必须报错 ───────────────────────

console.log('\n[3] 非法画布');
throwsCanvas('有环 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'agent', data: {} },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'b', to: 'a' },
      { id: 'e3', from: 'b', to: 'c' },
    ],
  });
}, '环');

throwsCanvas('未知节点类型 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'webhook', data: {} },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [],
  });
}, '不支持的节点类型');

throwsCanvas('缺 trigger → 报错', () => {
  compile({ nodes: [{ id: 'c', type: 'output', data: {} }], edges: [] });
}, 'trigger');

throwsCanvas('缺 output → 报错', () => {
  compile({ nodes: [{ id: 'a', type: 'trigger', data: {} }], edges: [] });
}, 'output');

throwsCanvas('空画布 → 报错', () => {
  compile({ nodes: [], edges: [] });
}, '空');

throwsCanvas('悬空连线 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'zzz' }],
  });
}, '不存在');

throwsCanvas('引用不存在的上游 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'agent', data: { prompt: '看 {{nope}}' } },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'b', to: 'c' },
    ],
  });
}, '不存在的节点');

// ─────────────────────── 4. apply() 挂载模拟 ───────────────────────

// ─────────────────────── 5. code 节点 ───────────────────────

console.log('\n[5] code 节点（内联脚本）');
const graphCode = {
  version: 1,
  name: 'code-test',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: '起点' } },
    { id: 'n2', type: 'agent', data: { prompt: '干活', label: 'A' } },
    { id: 'n3', type: 'code', data: { code: 'return "[" + inputs.n2 + "]";' } },
    { id: 'n4', type: 'output', data: {} },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'n3' },
    { id: 'e3', from: 'n3', to: 'n4' },
  ],
};
const compiledCode = compile(graphCode);
ok('code 被内联成 async IIFE', compiledCode.script.includes('await (async () => {'));
ok('code 的 inputs 含上游（现在给的是所有祖先）', compiledCode.script.includes('"n2": step_n2'));
const runCode = await runScript(compiledCode.script, { prompt: '起点' });
ok('code 的 return 成为节点值', runCode.value && runCode.value.result === '[AGENT_OUT]', String(runCode.value && runCode.value.result));

throwsCanvas('code 节点空代码 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'code', data: {} },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c' },
    ],
  });
}, '还没有代码');

// ─────────────────────── 6. condition 分支 ───────────────────────

console.log('\n[6] condition 分支');
const graphCond = {
  version: 1,
  name: 'cond-test',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: '默认' } },
    { id: 'n2', type: 'condition', data: { expr: 'inputs.n1 === "yes"', label: '判断' } },
    { id: 't1', type: 'agent', data: { prompt: 'then 路', label: 'T' } },
    { id: 'e1', type: 'agent', data: { prompt: 'else 路', label: 'E' } },
    { id: 'out', type: 'output', data: {} },
  ],
  edges: [
    { id: 'x1', from: 'n1', to: 'n2' },
    { id: 'x2', from: 'n2', to: 't1', branch: 'then' },
    { id: 'x3', from: 'n2', to: 'e1', branch: 'else' },
    { id: 'x4', from: 't1', to: 'out' },
    { id: 'x5', from: 'e1', to: 'out' },
  ],
};
const compiledCond = compile(graphCond);
console.log('--- 编译产物 ---');
console.log(compiledCond.script);
ok('生成 if/else 结构', compiledCond.script.includes('else {') && /if \(/.test(compiledCond.script));
ok('分支内变量在主循环之外 let 预声明', /let [^;]*step_t1[^;]*step_e1[^;]*;/.test(compiledCond.script) || /let [^;]*step_e1[^;]*step_t1[^;]*;/.test(compiledCond.script));

const runThen = await runScript(compiledCond.script, { prompt: 'yes' });
ok('条件为真 → 只跑 then 分支', runThen.calls.length === 1 && runThen.calls[0].opts.label === 'T', JSON.stringify(runThen.calls.map((c) => c.opts && c.opts.label)));

const runElse = await runScript(compiledCond.script, { prompt: 'no' });
ok('条件为假 → 只跑 else 分支', runElse.calls.length === 1 && runElse.calls[0].opts.label === 'E', JSON.stringify(runElse.calls.map((c) => c.opts && c.opts.label)));

throwsCanvas('condition 没有出边 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'condition', data: { expr: 'true' } },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [{ id: '1', from: 'a', to: 'b' }],
  });
}, '没有出边');

throwsCanvas('无条件出边不在最后 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'condition', data: {} },
      { id: 'c', type: 'agent', data: { label: 'C' } },
      { id: 'd', type: 'agent', data: { label: 'D' } },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c' },
      { id: '3', from: 'b', to: 'd', expr: 'inputs.a === "x"' },
      { id: '4', from: 'c', to: 'o' },
      { id: '5', from: 'd', to: 'o' },
    ],
  });
}, '必须排在最后');

// ─────────────────────── 7. 多个输出节点 + 中文条件拦截 ───────────────────────

console.log('\n[7] 多个输出节点 & 中文条件');
const graphTwoOut = {
  version: 1,
  name: 'two-output',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: 'x' } },
    { id: 'n2', type: 'condition', data: { expr: 'true', label: 'c' } },
    { id: 'a1', type: 'agent', data: { prompt: 'A 路', label: 'A' } },
    { id: 'b1', type: 'agent', data: { prompt: 'B 路', label: 'B' } },
    { id: 'o1', type: 'output', data: {} },
    { id: 'o2', type: 'output', data: {} },
  ],
  edges: [
    { id: '1', from: 'n1', to: 'n2' },
    { id: '2', from: 'n2', to: 'a1', branch: 'then' },
    { id: '3', from: 'n2', to: 'b1', branch: 'else' },
    { id: '4', from: 'a1', to: 'o1' },
    { id: '5', from: 'b1', to: 'o2' },
  ],
};
const cTwoOut = compile(graphTwoOut);
const returnCount = (cTwoOut.script.match(/^return /gm) || []).length;
ok('多 output → 合并成 1 个 return', returnCount === 1, '实际 ' + returnCount + ' 个');
ok('多 output 有汇总注释', cTwoOut.script.includes('多个输出节点 → 合并成一个 return'));
const rTwoOut = await runScript(cTwoOut.script, { prompt: 'x' });
ok('多 output 仍能跑通并回值', rTwoOut.value && rTwoOut.value.result === 'AGENT_OUT', JSON.stringify(rTwoOut.value && rTwoOut.value.result));

throwsCanvas('条件写成中文句子 → 拦下并说清怎么写', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'condition', data: { expr: '生成的数大于 50 小于等于 100' } },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c' },
    ],
  });
}, '中文句子');

throwsCanvas('条件括号不配对 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'condition', data: { expr: 'inputs.n1 > (50' } },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c' },
    ],
  });
}, '不是合法 JS');

// ─────────────────────── 8. AI 生成的纯函数 ───────────────────────

console.log('\n[8] AI 生成（纯函数）');
ok('提示词里禁死了中文条件', GENERATE_SYSTEM.includes('绝对不能用中文句子'));
ok('生成的脚本通过 args 传指令（不拼字符串）', buildGenerateScript().includes('args'));

const gen1 = extractGraph('{"name":"a","nodes":[],"edges":[]}');
ok('纯 JSON 能解析', Boolean(gen1) && gen1.name === 'a');
const gen2 = extractGraph('好的，这是图：\n```json\n{"name":"b","nodes":[],"edges":[]}\n```\n希望有用');
ok('```json 代码块能解析', Boolean(gen2) && gen2.name === 'b');
const gen3 = extractGraph('前言 {"name":"c","nodes":[],"edges":[]} 后记');
ok('夹着解释文字也能解析', Boolean(gen3) && gen3.name === 'c');
let genThrew = false;
try { extractGraph('完全不是 JSON'); } catch (e) { genThrew = true; }
ok('完全不是 JSON 会抛错', genThrew);

const norm = normalizeGraph({
  name: 't',
  nodes: [
    { type: 'trigger', data: { prompt: 'x' } },
    { id: 'b', type: 'made-up-type', data: {} },
    { id: 'c', type: 'output', data: {} },
    { id: 'd', type: 'output', data: {} },
  ],
  edges: [
    { from: 'n1', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'b', to: 'nope' },
    { from: 'b', to: 'c' },
  ],
});
ok('缺 id 会自动补', norm.nodes[0].id === 'n1', norm.nodes[0].id);
ok('非法类型降级成 agent', norm.nodes[1].type === 'agent', norm.nodes[1].type);
ok('悬空边与重复边被剔除', norm.edges.length === 2, '实际 ' + norm.edges.length);
ok('缺 position 时自动排版', norm.nodes.every((x) => x.position && Number.isFinite(x.position.x)));
ok('自动排版按层分开 x', norm.nodes[0].position.x < norm.nodes[2].position.x, norm.nodes[0].position.x + ' vs ' + norm.nodes[2].position.x);
ok('规整后的图能通过编译', compile(norm).script.length > 0);

// ─────────────────────── 9. 客户端冒烟：真跑一遍组件 ───────────────────────

console.log('\n[9] 客户端冒烟（真执行组件函数）');

const __dir = nodePath.dirname(fileURLToPath(import.meta.url));
const clientCode = nodeFs.readFileSync(nodePath.join(__dir, "lib", "client.js"), "utf8");

let clientFactory = null;
let clientExports = null;
let stateCallCount = 0;
const fakeReact = {
  createElement: (type, props) => ({ type: type, props: props }),
  // 第一个 useState 是面板的 open —— 强行置 true，好把「展开面板」那条分支也跑一遍
  useState: (init) => {
    stateCallCount += 1;
    if (stateCallCount === 1) return [true, () => {}];
    return [typeof init === "function" ? init() : init, () => {}];
  },
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useEffect: () => {},
};

const noopEl = { setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {}, style: {}, textContent: "" };
const sandbox = {
  window: {
    __ModuleLoader__: { load: (def) => { clientFactory = def.factory; } },
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1400,
    innerHeight: 900,
    confirm: () => true,
  },
  document: { querySelector: () => null, createElement: () => noopEl, head: { appendChild: () => {} } },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
  EventSource: function () { this.close = () => {}; this.addEventListener = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  AbortController: function () { this.signal = {}; this.abort = () => {}; },
  console: console,
  setTimeout: () => 0,
  clearTimeout: () => {},
};
sandbox.globalThis = sandbox;

let clientLoadErr = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
} catch (err) {
  clientLoadErr = err;
}
ok("client.js 能在假浏览器里加载", clientLoadErr === null, clientLoadErr && String(clientLoadErr.message));
ok("client factory 已注册", typeof clientFactory === "function");

if (typeof clientFactory === "function") {
  let exportsErr = null;
  try {
    clientExports = clientFactory(function () { return fakeReact; });
  } catch (err) {
    exportsErr = err;
  }
  ok("factory 执行不抛错", exportsErr === null, exportsErr && String(exportsErr.message));
  ok("导出了 apply", Boolean(clientExports) && typeof clientExports.apply === "function");
  ok(
    "客户端有「📊 运行结果」按钮，且结果会被攒住（收起后能调回来）",
    clientCode.includes("📊 运行结果") && clientCode.includes("lastResult") && clientCode.includes("showLastResult"),
  );
  ok(
    "客户端有「🖼 看成品」+ 双击看大图（灯箱）",
    clientCode.includes("🖼 看成品") && clientCode.includes("setLightbox") && clientCode.includes("zoom-in"),
  );
  ok(
    "客户端有「🧹 清理」按钮（打 host 的 /cleanup）",
    clientCode.includes("🧹 清理") && clientCode.includes("/cleanup") && clientCode.includes("runCleanup"),
  );
  ok(
    "客户端有「对话模式」外部运行支持（firehose + 横幅 + 退出）",
    clientCode.includes("canvas/external") && clientCode.includes("externalRunRef") && clientCode.includes("退出对话模式"),
  );
  ok(
    "客户端有产物操作（看大图 / 复制图片 / 复制路径 / 打开位置）",
    clientCode.includes("📋 复制图片") &&
      clientCode.includes("📋 复制路径") &&
      clientCode.includes("📂 打开位置") &&
      clientCode.includes("/reveal") &&
      clientCode.includes("ClipboardItem"),
  );
  ok(
    "结果面板与灯箱共用同一套产物按钮（结果预览可双击看大图）",
    clientCode.includes("previewActions(") && clientCode.includes("onDoubleClick"),
  );
  ok(
    "面板可拖动（标题条把手）+ 底色不透明（皮肤半透明变量不会透出对话）",
    clientCode.includes("startPanelDrag") &&
      clientCode.includes("panelRef") &&
      clientCode.includes("background-color:#fffdf8") &&
      clientCode.includes("按住这里拖动面板"),
  );
  ok(
    "日志区高度可拖（分隔条）+ 画布区有下限高度（不会被日志盖住）",
    clientCode.includes("startLogSplit") &&
      clientCode.includes("dsh-canvas-logsplit") &&
      clientCode.includes("min-height:160px") &&
      clientCode.includes("调整日志区高度"),
  );
  ok(
    "客户端有节点信息位（模型/耗时/花费那一行）",
    clientCode.includes("detailState") && clientCode.includes("props.detail") && clientCode.includes("details["),
  );
  ok(
    "客户端有窄屏适配（手机改成底部抽屉，不再往右挤）",
    clientCode.includes("narrowState") && clientCode.includes("max-width:700px") && clientCode.includes("74vh"),
  );

  // 内置模板必须**逐个能编译** —— 模板跑不起来就等于没有
  const tpls = clientExports && clientExports.TEMPLATES;
  ok("导出了 TEMPLATES", Array.isArray(tpls) && tpls.length >= 4, "实际 " + (tpls ? tpls.length : 0));
  if (Array.isArray(tpls)) {
    let tplBad = [];
    for (const tpl of tpls) {
      try {
        const built = tpl.build();
        // 带审批门的模板不能用 compile()（审批由结构层处理）→ 走 compileSplits（N+1 段）
        const gates = (built.nodes || []).filter((n) => n && n.type === 'approval').map((n) => n.id);
        const compiled =
          gates.length > 0
            ? mod.compileSplits(built, gates).segments[0]
            : compile(built);
        if (!compiled.script || compiled.script.length === 0) tplBad.push(tpl.id + "(空产物)");
      } catch (err) {
        tplBad.push(tpl.id + ": " + err.message);
      }
    }
    ok("每个模板都能编译", tplBad.length === 0, tplBad.join(" | "));
  }

  if (clientExports && typeof clientExports.apply === "function") {
    const registered = [];
    const scopedCtx = {
      inject: (deps, cb) => {
        cb({
          slots: {
            inject: (slotName, fn) => fn(),
            register: (def, Component) => {
              registered.push({ def: def, Component: Component });
              return () => {};
            },
          },
        });
      },
    };
    let applyErr = null;
    try { clientExports.apply(scopedCtx); } catch (err) { applyErr = err; }
    ok("客户端的 apply() 不抛错", applyErr === null, applyErr && String(applyErr.message));
    ok("注册了 1 个 slot 组件", registered.length === 1, "实际 " + registered.length);

    if (registered.length > 0) {
      stateCallCount = 0;
      let renderErr = null;
      try {
        registered[0].Component({});
      } catch (err) {
        renderErr = err;
      }
      ok("渲染组件不抛错（能抓 xxx is not defined）", renderErr === null, renderErr && String(renderErr.message));
    }
  }
}

// ─────────────────────── 10. 链式判断（if / else if / else）───────────────────────

console.log('\n[10] 链式判断');

const graphChain = {
  version: 1,
  name: 'chain-test',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: '5' } },
    { id: 'n2', type: 'condition', data: { expr: 'Number(inputs.n1) > 10', label: '大' } },
    { id: 'n3', type: 'agent', data: { prompt: '很大', label: 'BIG' } },
    { id: 'n4', type: 'condition', data: { expr: 'Number(inputs.n1) > 5', label: '中' } },
    { id: 'n6', type: 'agent', data: { prompt: '中等', label: 'MID' } },
    { id: 'n7', type: 'agent', data: { prompt: '很小', label: 'SMALL' } },
    { id: 'out', type: 'output', data: {} },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'n3', branch: 'then' },
    { id: 'e3', from: 'n2', to: 'n4', branch: 'else' },
    { id: 'e4', from: 'n4', to: 'n6', branch: 'then' },
    { id: 'e5', from: 'n4', to: 'n7', branch: 'else' },
    { id: 'e6', from: 'n3', to: 'out' },
    { id: 'e7', from: 'n6', to: 'out' },
    { id: 'e8', from: 'n7', to: 'out' },
  ],
};

const compiledChain = compile(graphChain);
console.log("--- 链式判断的编译产物 ---");
console.log(compiledChain.script);

// __pick 里也有一个 if —— 数链式结构时先把它那行去掉
const chainScript = compiledChain.script.replace(/const __pick = .*/, "");
const ifCount = (chainScript.match(/if \(/g) || []).length;
ok('生成了两层 if（else 里再嵌一层）', ifCount === 2, '实际 ' + ifCount + ' 个');
ok('嵌套的 condition 变量走顶层 let', /let step_n4/.test(compiledChain.script) || /let .*step_n4/.test(compiledChain.script));

const runBig = await runScript(compiledChain.script, { prompt: '20' });
ok('输入 20 → 只跑 BIG', runBig.calls.length === 1 && runBig.calls[0].opts.label === 'BIG', JSON.stringify(runBig.calls.map((c) => c.opts && c.opts.label)));

const runMid = await runScript(compiledChain.script, { prompt: '7' });
ok('输入 7 → 只跑 MID（落到了第二个判断）', runMid.calls.length === 1 && runMid.calls[0].opts.label === 'MID', JSON.stringify(runMid.calls.map((c) => c.opts && c.opts.label)));

const runSmall = await runScript(compiledChain.script, { prompt: '2' });
ok('输入 2 → 只跑 SMALL', runSmall.calls.length === 1 && runSmall.calls[0].opts.label === 'SMALL', JSON.stringify(runSmall.calls.map((c) => c.opts && c.opts.label)));

// ─────────────────────── 11. 多路扇出（一个判断 N 条出边）───────────────────────

console.log('\n[11] 多路扇出');

/** 三路判断：>66 走 HIGH，>33 走 MID，否则兜底走 LOW。 */
function buildMultiway(withFallback) {
  const edges = [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'a', expr: 'Number(inputs.n1) > 66' },
    { id: 'e3', from: 'n2', to: 'b', expr: 'Number(inputs.n1) > 33' },
  ];
  if (withFallback) edges.push({ id: 'e4', from: 'n2', to: 'c', branch: 'else' });
  edges.push(
    { id: 'e5', from: 'a', to: 'out' },
    { id: 'e6', from: 'b', to: 'out' },
  );
  if (withFallback) edges.push({ id: 'e7', from: 'c', to: 'out' });
  return {
    version: 1,
    name: 'multiway',
    nodes: [
      { id: 'n1', type: 'trigger', data: { prompt: '50' } },
      { id: 'n2', type: 'condition', data: { label: '打分' } },
      { id: 'a', type: 'agent', data: { prompt: '很高', label: 'HIGH' } },
      { id: 'b', type: 'agent', data: { prompt: '中等', label: 'MID' } },
      { id: 'c', type: 'agent', data: { prompt: '很低', label: 'LOW' } },
      { id: 'out', type: 'output', data: {} },
    ],
    edges,
  };
}

const cm = compile(buildMultiway(true));
console.log("--- 三路判断的编译产物 ---");
console.log(cm.script);

ok('生成 else if（多路）', cm.script.includes('else if ('));
ok('每路记录命中序号', cm.script.includes('step_n2 = 1;') && cm.script.includes('step_n2 = 2;') && cm.script.includes('step_n2 = 3;'));

const rHi = await runScript(cm.script, { prompt: '80' });
ok('80 → 只跑 HIGH', rHi.calls.length === 1 && rHi.calls[0].opts.label === 'HIGH', JSON.stringify(rHi.calls.map((c) => c.opts && c.opts.label)));

const rMid = await runScript(cm.script, { prompt: '50' });
ok('50 → 只跑 MID', rMid.calls.length === 1 && rMid.calls[0].opts.label === 'MID', JSON.stringify(rMid.calls.map((c) => c.opts && c.opts.label)));

const rLow = await runScript(cm.script, { prompt: '10' });
ok('10 → 只跑 LOW（兜底）', rLow.calls.length === 1 && rLow.calls[0].opts.label === 'LOW', JSON.stringify(rLow.calls.map((c) => c.opts && c.opts.label)));

const rNone = await runScript(compile(buildMultiway(false)).script, { prompt: '10' });
ok('没有兜底且全不成立 → 一个子代理都不跑', rNone.calls.length === 0, String(rNone.calls.length));
ok('此时 outputs 被 __pick 剔干净（仍是合法 JSON）', rNone.value && Object.keys(rNone.value.outputs).length === 0, JSON.stringify(rNone.value && rNone.value.outputs));

throwsCanvas('多条无条件出边 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'condition', data: {} },
      { id: 'c', type: 'agent', data: {} },
      { id: 'd', type: 'agent', data: {} },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c' },
      { id: '3', from: 'b', to: 'd' },
      { id: '4', from: 'c', to: 'o' },
      { id: '5', from: 'd', to: 'o' },
    ],
  });
}, '只能留一条兜底');

throwsCanvas('某一路条件写成中文 → 报错（校验搬到边上后仍有效）', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'condition', data: {} },
      { id: 'c', type: 'agent', data: {} },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c', expr: '分数大于 60' },
      { id: '3', from: 'c', to: 'o' },
    ],
  });
}, '中文句子');

// ─────────────────────── 12. 只输出结果（terse）───────────────────────

console.log('\n[12] 只输出结果');

function terseGraph(terseValue) {
  const data = { prompt: '用一句话夸夸', label: '夸' };
  if (terseValue !== undefined) data.terse = terseValue;
  return {
    version: 1,
    name: 'terse',
    nodes: [
      { id: 'n1', type: 'trigger', data: { prompt: '50' } },
      { id: 'n2', type: 'agent', data },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [ { id: 'e1', from: 'n1', to: 'n2' }, { id: 'e2', from: 'n2', to: 'o' } ],
  };
}

const sDefault = compile(terseGraph(undefined)).script;
ok('默认就带输出约束', sDefault.includes('【输出要求】'));
ok('默认日志标注了「只输出结果」', sDefault.includes('（只输出结果）'));

const sOff = compile(terseGraph(false)).script;
ok('terse:false 时不加约束', !sOff.includes('【输出要求】'));

const sOn = compile(terseGraph(true)).script;
ok('terse:true 时加约束', sOn.includes('【输出要求】'));

// ─────────────────────── 13. parallel 并行扇出 ───────────────────────

console.log('\n[13] parallel 并行扇出');

const graphPar = {
  version: 1,
  name: 'parallel-test',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: '主题：深海' } },
    { id: 'p', type: 'parallel', data: {} },
    { id: 'a', type: 'agent', data: { prompt: '用一句话描写主题', label: 'A' } },
    { id: 'b', type: 'agent', data: { prompt: '再用一句话描写主题', label: 'B' } },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'p' },
    { id: 'e2', from: 'p', to: 'a' },
    { id: 'e3', from: 'p', to: 'b' },
    { id: 'e4', from: 'a', to: 'o' },
    { id: 'e5', from: 'b', to: 'o' },
  ],
};

const cp = compile(graphPar);
console.log("--- parallel 的编译产物 ---");
console.log(cp.script);

ok('生成了 await parallel([...])', cp.script.includes('await parallel(['));
ok('两条分叉都在 thunk 里', (cp.script.match(/\(\) => agent\(/g) || []).length === 2, String((cp.script.match(/\(\) => agent\(/g) || []).length));
ok('分叉结果按下标取回', cp.script.includes('[0]') && cp.script.includes('[1]'));

// 控制流节点不是数据源：自动拼接要穿透它们，拿真正有值的上游
ok('分叉 agent 拼的是数据上游 n1，不是并行节点 p', cp.script.indexOf('【上游 n1】') >= 0 && cp.script.indexOf('【上游 p】') < 0, 'n1=' + (cp.script.indexOf('【上游 n1】') >= 0) + ' p=' + (cp.script.indexOf('【上游 p】') >= 0));

const gCondUp = {
  version: 1,
  name: 'cond-upstream',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: '原始数据' } },
    { id: 'n2', type: 'condition', data: { label: '判断' } },
    { id: 'a', type: 'agent', data: { prompt: '处理一下', label: 'A' } },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { id: '1', from: 'n1', to: 'n2' },
    { id: '2', from: 'n2', to: 'a', expr: 'true' },
    { id: '3', from: 'a', to: 'o' },
  ],
};
const cCondUp = compile(gCondUp);
ok('判断下游的 agent 拼的是 n1，不是判断节点', cCondUp.script.indexOf('【上游 n1】') >= 0 && cCondUp.script.indexOf('【上游 n2】') < 0);

const runPar = await runScript(cp.script, { prompt: '主题：深海' });
ok('两条分叉都执行了', runPar.calls.length === 2, String(runPar.calls.length));
ok('两个 agent 的 label 都对', runPar.calls.map((c) => c.opts && c.opts.label).sort().join(',') === 'A,B', JSON.stringify(runPar.calls.map((c) => c.opts && c.opts.label)));
ok('汇合点拿得到两路结果', runPar.value && runPar.value.outputs && runPar.value.outputs.a === 'AGENT_OUT' && runPar.value.outputs.b === 'AGENT_OUT');

throwsCanvas('parallel 的分叉接了 code 节点 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'p', type: 'parallel', data: {} },
      { id: 'c', type: 'code', data: { code: 'return 1;' } },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'p' },
      { id: '2', from: 'p', to: 'c' },
      { id: '3', from: 'c', to: 'o' },
    ],
  });
}, '只能接「子代理」节点');

throwsCanvas('parallel 没有出边 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'p', type: 'parallel', data: {} },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [ { id: '1', from: 'a', to: 'p' } ],
  });
}, '没有出边');

// ─────────────────────── 14. 失败重试 ───────────────────────

console.log('\n[14] 失败重试');

function retryGraph(retryTimes) {
  const data = { prompt: '干活', label: '干' };
  if (retryTimes !== undefined) data.retry = retryTimes;
  return {
    version: 1,
    name: 'retry',
    nodes: [
      { id: 'n1', type: 'trigger', data: { prompt: 'x' } },
      { id: 'n2', type: 'agent', data },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [ { id: 'e1', from: 'n1', to: 'n2' }, { id: 'e2', from: 'n2', to: 'o' } ],
  };
}

const cRetry = compile(retryGraph(2));
ok('生成了 for 重试循环', cRetry.script.includes('for (let __t_'), cRetry.script.split('\n').filter((l) => l.includes('__t_')).join(' | '));
ok('有重试时改用 let 先声明（避免 const 出不了循环）', cRetry.script.includes('let step_n2;'));

// 第 1 次失败、第 2 次成功
let attempt = 0;
const runRetry = await runScript(cRetry.script, { prompt: 'x' }, () => {
  attempt += 1;
  return attempt === 1 ? null : 'OK_AFTER_RETRY';
});
ok('第一次失败、第二次成功 → 一共调用 2 次', runRetry.calls.length === 2, String(runRetry.calls.length));
ok('最终拿到成功的值', runRetry.value && runRetry.value.result === 'OK_AFTER_RETRY', String(runRetry.value && runRetry.value.result));

// 一直失败 → 用满 1 + 2 = 3 次
const runAllFail = await runScript(cRetry.script, { prompt: 'x' }, () => null);
ok('一直失败 → 用满 1 + 2 = 3 次', runAllFail.calls.length === 3, String(runAllFail.calls.length));
ok('全失败时返回值仍是合法 JSON（__pick 起作用）', runAllFail.value && Object.keys(runAllFail.value.outputs).length === 0);

// 不设 retry → 只跑一次
const runNoRetry = await runScript(compile(retryGraph(undefined)).script, { prompt: 'x' }, () => null);
ok('没设重试 → 只调用 1 次', runNoRetry.calls.length === 1, String(runNoRetry.calls.length));

// ─────────────────────── 15. P0 回归（独立审查实测出来的三个）───────────────────────

console.log('\n[15] P0 回归');

// ① 单路无条件的判断 → 之前会生成 `else {` 开头的坏脚本（SyntaxError）
throwsCanvas('判断只有一条出边且无条件 → 报错', () => {
  compile({
    nodes: [
      { id: 'a', type: 'trigger', data: {} },
      { id: 'b', type: 'condition', data: {} },
      { id: 'c', type: 'output', data: {} },
    ],
    edges: [
      { id: '1', from: 'a', to: 'b' },
      { id: '2', from: 'b', to: 'c' },
    ],
  });
}, '第一条出边必须带条件');

// ② parallel 落在判断分支里 → 之前 parallel([...]) 根本没生成（掉进 output 代码）
const gNestedPar = {
  version: 1,
  name: 'nested-parallel',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: 'x' } },
    { id: 'n2', type: 'condition', data: { label: 'c' } },
    { id: 'p', type: 'parallel', data: {} },
    { id: 'a', type: 'agent', data: { prompt: 'A', label: 'A' } },
    { id: 'b', type: 'agent', data: { prompt: 'B', label: 'B' } },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { id: '1', from: 'n1', to: 'n2' },
    { id: '2', from: 'n2', to: 'p', expr: 'true' },
    { id: '3', from: 'p', to: 'a' },
    { id: '4', from: 'p', to: 'b' },
    { id: '5', from: 'a', to: 'o' },
    { id: '6', from: 'b', to: 'o' },
  ],
};
const cNestedPar = compile(gNestedPar);
ok('分支里的 parallel 真的生成了 await parallel([...])', cNestedPar.script.includes('await parallel(['));
const rNestedPar = await runScript(cNestedPar.script, { prompt: 'x' });
ok('分支里的 parallel 两条分叉都跑', rNestedPar.calls.length === 2, String(rNestedPar.calls.length));

// ③ normalizeIncoming：外来画布的兜底（缺 position / 缺 id / 悬空边）
const ni = clientExports && clientExports.normalizeIncoming;
ok('导出了 normalizeIncoming', typeof ni === 'function');
if (typeof ni === 'function') {
  const gIn = ni({
    name: 'from-outside',
    nodes: [{ id: 'x', type: 'agent' }, { type: 'agent' }, { id: 'x', type: 'output' }],
    edges: [{ from: 'x', to: 'n2' }, { from: 'nope', to: 'x' }, { from: 'x', to: 'x' }],
  });
  ok('缺 position 会被补上', gIn.nodes.every((n) => n.position && typeof n.position.x === 'number'), JSON.stringify(gIn.nodes.map((n) => n.position)));
  ok('缺 id 会被补上、重复 id 会去重', gIn.nodes.length === 3 && new Set(gIn.nodes.map((n) => n.id)).size === 3, gIn.nodes.map((n) => n.id).join(','));
  ok('悬空边 / 自环被剔除', gIn.edges.length === 1, String(gIn.edges.length));
}

// ─────────────────────── 16. output 与控制流节点 ───────────────────────

console.log('\n[16] output 与控制流');

// ⑧ output 的直接上游是判断节点时，要**穿透**取数据（否则拿到的是「命中第几路」）
const gOutThru = {
  version: 1,
  name: 'out-through',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: '数据' } },
    { id: 'n2', type: 'condition', data: { label: 'c' } },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { id: '1', from: 'n1', to: 'n2' },
    { id: '2', from: 'n2', to: 'o', expr: 'true' },
  ],
};
const cOutThru = compile(gOutThru);
ok('output 穿透控制节点（取 n1 而不是判断 n2）', cOutThru.script.indexOf('"n1": step_n1') >= 0 && cOutThru.script.indexOf('"n2": step_n2') < 0);
const rOutThru = await runScript(cOutThru.script, { prompt: '数据' });
ok('output 拿到的是数据、不是命中序号', rOutThru.value && rOutThru.value.result === '数据', JSON.stringify(rOutThru.value && rOutThru.value.result));

// ⑨ output 落在分支里（**反例**：condition → agent → output，output 不在判断的直接下游）
const gOutInBranch = {
  version: 1,
  name: 'out-in-branch',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: 'x' } },
    { id: 'n2', type: 'condition', data: { label: 'c' } },
    { id: 'a', type: 'agent', data: { prompt: 'A', label: 'A' } },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { id: '1', from: 'n1', to: 'n2' },
    { id: '2', from: 'n2', to: 'a', expr: 'false' },
    { id: '3', from: 'a', to: 'o' },
  ],
};
const cOutInBranch = compile(gOutInBranch);
ok('output 在分支里 → 走合并 return', cOutInBranch.script.includes('多个输出节点'));
const rOutInBranch = await runScript(cOutInBranch.script, { prompt: 'x' });
ok('条件为假 → 不跑子代理', rOutInBranch.calls.length === 0, String(rOutInBranch.calls.length));
ok('此时返回值是 null（合法 JSON）而不是 undefined', rOutInBranch.value !== undefined && rOutInBranch.value.result === null, JSON.stringify(rOutInBranch.value && rOutInBranch.value.result));

// ─────────────────────── 17. 人工审批 · 切段编译 ───────────────────────

console.log('\n[17] 人工审批 · 切段编译');

const graphAppr = {
  version: 1,
  name: 'approval-test',
  nodes: [
    { id: 'n1', type: 'trigger', data: { prompt: '写个草稿' } },
    { id: 'n2', type: 'agent', data: { prompt: '写草稿', label: '草稿' } },
    { id: 'ap', type: 'approval', data: { note: '草稿行不行？' } },
    { id: 'n3', type: 'agent', data: { prompt: '润色一下', label: '润色' } },
    { id: 'o', type: 'output', data: {} },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'ap' },
    { id: 'e3', from: 'ap', to: 'n3' },
    { id: 'e4', from: 'n3', to: 'o' },
  ],
};

const sp = compileSplit(graphAppr, 'ap');
ok('切出了两段', Boolean(sp.pre) && Boolean(sp.post));
ok('审批说明带得出来', sp.approval.note === '草稿行不行？', sp.approval.note);
ok('默认说明有兜底', compileSplit({ nodes: [ {id:'a',type:'trigger',data:{}}, {id:'ap',type:'approval',data:{}}, {id:'b',type:'agent',data:{}}, {id:'o2',type:'output',data:{}} ], edges: [{id:'1',from:'a',to:'ap'},{id:'2',from:'ap',to:'b'},{id:'3',from:'b',to:'o2'}] }, 'ap').approval.note.length > 0);
ok('段1 只含审批之前的节点', sp.pre.script.includes('写草稿') && !sp.pre.script.includes('润色'));
ok('段2 只含审批之后的节点', sp.post.script.includes('润色') && !sp.post.script.includes('写草稿'));

// 段1 真跑
const rPre = await runScript(sp.pre.script, { prompt: '写个草稿' });
ok('段1 跑通并产出结果', rPre.calls.length === 1 && rPre.value.result === 'AGENT_OUT', JSON.stringify(rPre.value && rPre.value.result));

// 段2 带着 checkpoint 真跑（模拟"点了通过"）
const rPost = await runScript(sp.post.script, { prompt: rPre.value.result });
ok('段2 跑通', rPost.calls.length === 1 && rPost.calls[0].opts.label === '润色', JSON.stringify(rPost.calls.map((c) => c.opts && c.opts.label)));
ok('段2 的起点拿到了段1的结果', rPost.calls[0].prompt.includes('AGENT_OUT'), rPost.calls[0].prompt.slice(0, 60));

throwsCanvas('审批节点后面没接节点 → 报错', () => {
  compileSplit({
    nodes: [ { id: 'a', type: 'trigger', data: {} }, { id: 'ap', type: 'approval', data: {} } ],
    edges: [ { id: '1', from: 'a', to: 'ap' } ],
  }, 'ap');
}, '后面没有接任何节点');

console.log('\n[4] host 半边 apply() 挂载模拟（防"重启炸树" + 验降级路径）');
ok('导出 name = dsh-canvas', mod.name === 'dsh-canvas');
ok('inject 只含 webServer（引擎走第二层 inject）', Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'webServer');
ok('导出 apply 是函数', typeof mod.apply === 'function');

/**
 * 造一个假 ctx，**如实复刻 Cordis 那条最坑的语义**：
 * `inject(deps, cb)` 只要 deps 里有一个服务不可用，回调就**静默不执行**。
 */
function makeCtx(available) {
  const routes = [];
  const events = [];
  const services = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    workflowEngine: { start: () => {} },
  };
  const ctx = {
    get: (n) => (available.includes(n) ? services[n] : undefined),
    inject: (deps, cb) => {
      if (!deps.every((d) => available.includes(d))) return;
      const scope = { inject: ctx.inject };
      for (const d of deps) scope[d] = services[d];
      cb(scope);
    },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on: (name) => {
      events.push(name);
      return () => {};
    },
    logger: {
      info: () => {},
      warn: (m) => console.log('   [warn] ' + m),
    },
  };
  return { ctx, routes, events };
}

// 场景 A：引擎缺席 —— 插件必须降级而不是整块静默失效
const a = makeCtx(['webServer']);
let threwA = null;
try {
  mod.apply(a.ctx);
} catch (err) {
  threwA = err;
}
ok('引擎缺席时 apply() 不抛错', threwA === null, threwA && String(threwA.message));
ok('引擎缺席时照样挂满 14 条路由（路由不绑引擎 — 401 的教训）', a.routes.length === 14, '实际 ' + a.routes.length);
ok('引擎缺席时也订阅 6 个 workflow/* 事件', a.events.length === 6, '实际 ' + a.events.length);

// 场景 B：引擎就绪 —— 全量路由 + 事件订阅
const b = makeCtx(['webServer', 'workflowEngine']);
let threwB = null;
try {
  mod.apply(b.ctx);
} catch (err) {
  threwB = err;
}
ok('引擎就绪时 apply() 不抛错', threwB === null, threwB && String(threwB.message));
ok('引擎就绪时挂满 14 条路由', b.routes.length === 14, '实际 ' + b.routes.length);

const paths = b.routes.map((r) => r.path).sort();
const expectedPaths = [
  '/api/dsh-canvas/asset',
  '/api/dsh-canvas/cleanup',
  '/api/dsh-canvas/compile',
  '/api/dsh-canvas/events',
  '/api/dsh-canvas/generate',
  '/api/dsh-canvas/graph',
  '/api/dsh-canvas/graph/delete',
  '/api/dsh-canvas/graphs',
  '/api/dsh-canvas/probe',
  '/api/dsh-canvas/report',
  '/api/dsh-canvas/reveal',
  '/api/dsh-canvas/run',
  '/api/dsh-canvas/stop',
  '/dsh-canvas/probe',
].sort();
ok('路由路径与设计一致', JSON.stringify(paths) === JSON.stringify(expectedPaths), paths.join(', '));
ok('每条路由都是 exact 且带 handler', b.routes.every((r) => r.kind === 'exact' && typeof r.handler === 'function'));

const wantedEvents = ['workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'];
ok('订阅了全部 6 个 workflow/* 事件', wantedEvents.every((e) => b.events.includes(e)), b.events.join(', '));

// ───────────── /asset 受控图片路由（白名单 / 穿越 / 类型） ─────────────

const assetRoute = b.routes.find((r) => r.path === '/api/dsh-canvas/asset');
ok('挂上了 /asset 路由', !!assetRoute);

function hitAsset(qs) {
  const out = { status: 0, headers: null, body: null };
  const req = { url: '/api/dsh-canvas/asset?' + qs };
  const res = {
    setHeader() {},
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
      return this;
    },
    end(chunk) {
      out.body = chunk;
      return this;
    },
  };
  assetRoute.handler(req, res);
  return out;
}
const enc = (p) => 'path=' + encodeURIComponent(p);
const IMG_DIR = nodePath.join('D:', 'dsh-media', 'images');

let realImg = null;
try {
  realImg = nodeFs.readdirSync(IMG_DIR).find((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)) || null;
} catch {
  /* 目录可能不存在 */
}
if (realImg) {
  const r = hitAsset(enc(nodePath.join(IMG_DIR, realImg)));
  ok(
    '白名单内的真图 → 200 且 content-type 是图片',
    r.status === 200 && String(r.headers?.['content-type'] ?? '').startsWith('image/'),
    `${r.status} ${r.headers?.['content-type']}`,
  );
  ok('返回的是真字节（不是空）', Buffer.isBuffer(r.body) && r.body.length > 100, String(r.body?.length));
} else {
  console.log('  (跳过真实图片断言：白名单目录里没有图片)');
}

ok('缺 path 参数 → 400', hitAsset('').status === 400);
ok(
  '白名单外的路径 → 403（不能读任意文件）',
  hitAsset(enc(nodePath.join(process.env.USERPROFILE || 'C:\\', '.dsh', 'memory.md'))).status === 403,
);
ok('目录穿越（..\\..\\ 未归一化）→ 403', hitAsset(enc(IMG_DIR + '\\..\\..\\Windows\\win.ini')).status === 403);
ok('白名单内但非图片扩展名 → 415', hitAsset(enc(nodePath.join(IMG_DIR, 'x.txt'))).status === 415);
ok('白名单内但文件不存在 → 404', hitAsset(enc(nodePath.join(IMG_DIR, '__definitely_missing__.png'))).status === 404);

// ───────────── label → nodeId 还原表（P0-4 节点级事件） ─────────────

const idx = mod.labelIndex(compile({
  version: 1,
  name: 'label-index',
  nodes: [
    { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: '起点·参考图' } },
    { id: 'n2', type: 'agent', position: { x: 1, y: 0 }, data: { label: '出图' } },
    { id: 'n3', type: 'agent', position: { x: 2, y: 0 }, data: {} }, // 没写 label → 用 id 当 label
    { id: 'n4', type: 'output', position: { x: 3, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'n3' },
    { id: 'e3', from: 'n3', to: 'n4' },
  ],
}));
ok('label 表：写了 label 的按 label 映射', idx.get('出图') === 'n2');
ok('label 表：没写 label 的用 id 兜底', idx.get('n3') === 'n3');
ok('label 表：trigger/output 也在表里', idx.get('起点·参考图') === 'n1' && idx.get('n4') === 'n4');
ok('label 表：查不到返回 undefined（前端会退回按 label 匹配）', idx.get('不存在的名字') === undefined);
ok('label 表：空输入不抛错', mod.labelIndex(null).size === 0 && mod.labelIndex({}).size === 0);

// ───────────── 图像节点（P0-5）：产物路径解析 + 编译 ─────────────

ok(
  'findImagePath：从「✔ 已存: D:\\...png (1459 KB)」里捞出路径',
  mod.findImagePath('✔ 已存: D:\\dsh-media\\images\\edit-2026.png (1459 KB)') ===
    'D:\\dsh-media\\images\\edit-2026.png',
);
ok('findImagePath：多个路径取最后一个', mod.findImagePath('a D:\\x\\1.png b D:\\y\\2.jpg') === 'D:\\y\\2.jpg');
ok(
  'findImagePath：带解释文字也能认出（正斜杠）',
  mod.findImagePath('已生成，路径是 D:/dsh-work/out/a.webp 请查收') === 'D:/dsh-work/out/a.webp',
);
ok('findImagePath：没有路径 → null', mod.findImagePath('失败：没有生成任何图片') === null);
ok('findImagePath：普通文本不误判', mod.findImagePath('C:\\Windows 目录') === null);

let imgCompiled = null;
let imgErr = null;
try {
  imgCompiled = compile({
    version: 1,
    name: 'img-node',
    nodes: [
      { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, data: { prompt: '起点' } },
      { id: 'gen1', type: 'image', position: { x: 1, y: 0 }, data: { prompt: '画一只鲸鱼娘', provider: 'modelscope' } },
      {
        id: 'edit1',
        type: 'image',
        position: { x: 2, y: 0 },
        data: { prompt: '把背景换成星空', image: '{{gen1}}', provider: 'dashscope' },
      },
      { id: 'out', type: 'output', position: { x: 3, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'gen1' },
      { id: 'e2', from: 'gen1', to: 'edit1' },
      { id: 'e3', from: 'edit1', to: 'out' },
    ],
  });
} catch (e) {
  imgErr = e;
}
ok('图像节点能编译通过', imgCompiled !== null && imgErr === null, imgErr && imgErr.message);
if (imgCompiled) {
  const s = imgCompiled.script;
  ok('图像节点调的是本机 image-edit.mjs', s.includes('image-edit.mjs'));
  ok('没参考图 → 走 gen 模式', s.includes(' gen --prompt-file'));
  ok('有参考图（{{gen1}}）→ 走 edit 模式', s.includes(' edit <参考图> --prompt-file'));
  ok('edit 节点的 provider 写进了命令', s.includes('--provider dashscope'));
  ok(
    'gen 模式不写 provider（纯文生图统一走智谱 gen-image.mjs）',
    !s.includes('--provider modelscope'),
  );
  ok('产物路径回传标记写进了脚本', s.includes('@@canvas-image@@'));
  ok('参考图用 __pickPath 挑纯路径（防止把「修改意见」当文件名）', s.includes('__pickPath('));
  ok(
    'compile 返回 imageTmp（host 靠它轮询产物 → 缩略图）',
    !!imgCompiled.imageTmp &&
      Object.keys(imgCompiled.imageTmp).length === 2 &&
      /\.result$/.test(imgCompiled.imageTmp.gen1),
    JSON.stringify(imgCompiled.imageTmp),
  );
  ok('提示词里让子代理把产物路径写进约定文件（④ 步）', s.includes('.result'));
  ok('④ 步改成抄「META 开头那行」（节点信息位的来源）', s.includes('META 开头'));
  ok('节点变量按 id 命名（下游能 {{引用}}）', s.includes('step_gen1') && s.includes('step_edit1'));
  ok(
    'meta.phases 带上了两个图像节点的 phase（否则内核会挑刺）',
    Array.isArray(imgCompiled.meta?.phases) &&
      imgCompiled.meta.phases.some((p) => p.title === 'gen1') &&
      imgCompiled.meta.phases.some((p) => p.title === 'edit1'),
    JSON.stringify(imgCompiled.meta?.phases),
  );
}

let noPromptErr = null;
try {
  compile({
    version: 1,
    name: 'img-no-prompt',
    nodes: [
      { id: 's', type: 'trigger', position: { x: 0, y: 0 }, data: { prompt: 'x' } },
      { id: 'i', type: 'image', position: { x: 1, y: 0 }, data: {} },
      { id: 'o', type: 'output', position: { x: 2, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', from: 's', to: 'i' },
      { id: 'e2', from: 'i', to: 'o' },
    ],
  });
} catch (e) {
  noPromptErr = e;
}
ok(
  '图像节点没写指令 → 报 CanvasError 且提示清楚',
  noPromptErr instanceof CanvasError && /图像指令/.test(noPromptErr.message),
  noPromptErr && noPromptErr.message,
);

// ───────────── 多层长链（P0-6）：compileSplits ─────────────

const chainGraph = {
  version: 1,
  name: 'multi-approval',
  nodes: [
    { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, data: { prompt: '起点' } },
    { id: 'img1', type: 'agent', position: { x: 1, y: 0 }, data: { prompt: '出图', label: '出图1' } },
    { id: 'g1', type: 'approval', position: { x: 2, y: 0 }, data: { note: '第一关：满意吗？' } },
    { id: 'img2', type: 'agent', position: { x: 3, y: 0 }, data: { prompt: '改图', label: '改图2' } },
    { id: 'g2', type: 'approval', position: { x: 4, y: 0 }, data: { note: '第二关' } },
    { id: 'img3', type: 'agent', position: { x: 5, y: 0 }, data: { prompt: '再改', label: '改图3' } },
    { id: 'g3', type: 'approval', position: { x: 6, y: 0 }, data: { note: '第三关' } },
    { id: 'out', type: 'output', position: { x: 7, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'img1' },
    { id: 'e2', from: 'img1', to: 'g1' },
    { id: 'e3', from: 'g1', to: 'img2' },
    { id: 'e4', from: 'img2', to: 'g2' },
    { id: 'e5', from: 'g2', to: 'img3' },
    { id: 'e6', from: 'img3', to: 'g3' },
    { id: 'e7', from: 'g3', to: 'out' },
  ],
};

const splits = mod.compileSplits(chainGraph, ['g3', 'g1', 'g2']); // 故意乱序传，应被拓扑排序修正
ok('3 个审批门 → 切成 4 段', splits.segments.length === 4, String(splits.segments.length));
ok('3 个审批门 → 3 次问人（顺序按拓扑）', splits.approvals.map((a) => a.id).join(',') === 'g1,g2,g3', splits.approvals.map((a) => a.id).join(','));
ok('第 1 段 = 门之前（start/img1）', splits.segments[0].order.includes('img1') && !splits.segments[0].order.includes('img2'));
ok('第 2 段 = 两门之间（img2）', splits.segments[1].order.includes('img2') && !splits.segments[1].order.includes('img3'));
ok('第 3 段 = 两门之间（img3）', splits.segments[2].order.includes('img3') && !splits.segments[2].order.includes('out'));
ok('第 4 段 = 最后一个门之后（out）', splits.segments[3].order.includes('out'));
ok('中间段既有临时入口也有临时出口', /__seg1_in/.test(splits.segments[1].script) && /__seg1_out/.test(splits.segments[1].script));
ok('审批说明能带出来', splits.approvals[0].note === '第一关：满意吗？' && splits.approvals[1].note === '第二关');

// 单个门也要能走同一个函数（等价于老的 compileSplit）
const oneSplit = mod.compileSplits(chainGraph, ['g2']);
ok('1 个审批门 → 2 段', oneSplit.segments.length === 2 && oneSplit.approvals.length === 1);

// 两个门落在并行分支里 → 必须**明确拒绝**，而不是跑出静默丢节点的鬼结果
const parallelGates = {
  version: 1,
  name: 'parallel-gates',
  nodes: [
    { id: 's', type: 'trigger', position: { x: 0, y: 0 }, data: { prompt: 'x' } },
    { id: 'a', type: 'agent', position: { x: 1, y: 0 }, data: { prompt: 'a' } },
    { id: 'b', type: 'agent', position: { x: 1, y: 1 }, data: { prompt: 'b' } },
    { id: 'ga', type: 'approval', position: { x: 2, y: 0 }, data: { note: 'A' } },
    { id: 'gb', type: 'approval', position: { x: 2, y: 1 }, data: { note: 'B' } },
    { id: 'o', type: 'output', position: { x: 3, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e1', from: 's', to: 'a' },
    { id: 'e2', from: 's', to: 'b' },
    { id: 'e3', from: 'a', to: 'ga' },
    { id: 'e4', from: 'b', to: 'gb' },
    { id: 'e5', from: 'ga', to: 'o' },
    { id: 'e6', from: 'gb', to: 'o' },
  ],
};
let parallelErr = null;
try {
  mod.compileSplits(parallelGates, ['ga', 'gb']);
} catch (e) {
  parallelErr = e;
}
ok(
  '并行分支里的两个门 → 报错拒绝（提示"同一条链"）',
  parallelErr instanceof CanvasError && /同一条链/.test(parallelErr.message),
  parallelErr && parallelErr.message,
);

let notApprovalErr = null;
try {
  mod.compileSplits(chainGraph, ['img1']);
} catch (e) {
  notApprovalErr = e;
}
ok('传了非审批节点 → 报错', notApprovalErr instanceof CanvasError && /不是一个审批节点/.test(notApprovalErr.message));

// ───────────── 「上一段」别名（审批拆段后引用上一段的结果） ─────────────

const prevSugarGraph = {
  version: 1,
  name: 'prev-sugar',
  nodes: [
    { id: 's', type: 'trigger', position: { x: 0, y: 0 }, data: { prompt: '起点' } },
    { id: 'g1', type: 'approval', position: { x: 1, y: 0 }, data: { note: '看' } },
    { id: 'a1', type: 'agent', position: { x: 2, y: 0 }, data: { prompt: '按 {{上一段}} 继续', label: '继续' } },
    { id: 'g2', type: 'approval', position: { x: 3, y: 0 }, data: { note: '再看' } },
    { id: 'i1', type: 'image', position: { x: 4, y: 0 }, data: { prompt: '改成星空', image: '{{上一段}}' } },
    { id: 'o', type: 'output', position: { x: 5, y: 0 }, data: {} },
  ],
  edges: [
    { id: 'e0', from: 's', to: 'g1' },
    { id: 'e1', from: 'g1', to: 'a1' },
    { id: 'e2', from: 'a1', to: 'g2' },
    { id: 'e3', from: 'g2', to: 'i1' },
    { id: 'e4', from: 'i1', to: 'o' },
  ],
};
{
  const sugar = mod.compileSplits(prevSugarGraph, ['g1', 'g2']);
  ok(
    '{{上一段}}：第 2 段（agent 提示词里）解析到段间入口',
    sugar.segments[1].script.includes('step_seg1_in'),
  );
  ok(
    '{{上一段}}：第 3 段（图像节点的参考图里）解析到段间入口',
    sugar.segments[2].script.includes('step_seg2_in'),
  );
  ok(
    '图像节点的指令只取「主人的修改意见」，不把整坨路径/内部标记塞给模型（否则画面会被印上乱码字）',
    sugar.segments[2].script.includes('__pickOpinion(') && sugar.segments[2].script.includes('【要改的地方】'),
  );
  ok(
    'compileSplits 汇总各段的 imageTmp（缩略图轮询用）',
    !!(sugar.imageTmp && sugar.imageTmp.i1 && /\.result$/.test(sugar.imageTmp.i1)),
    JSON.stringify(sugar.imageTmp),
  );
}

{
  // 单门版（compileSplit）的段间入口叫 __approval_post_in，别名同样要能命中
  const single = compileSplit(
    {
      version: 1,
      name: 'prev-sugar-single',
      nodes: [
        { id: 's', type: 'trigger', position: { x: 0, y: 0 }, data: { prompt: '起点' } },
        { id: 'g1', type: 'approval', position: { x: 1, y: 0 }, data: { note: '看' } },
        { id: 'a1', type: 'agent', position: { x: 2, y: 0 }, data: { prompt: '按 {{上一段}} 继续' } },
        { id: 'o', type: 'output', position: { x: 3, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e0', from: 's', to: 'g1' },
        { id: 'e1', from: 'g1', to: 'a1' },
        { id: 'e2', from: 'a1', to: 'o' },
      ],
    },
    'g1',
  );
  ok(
    '{{上一段}}：单门版解析到 __approval_post_in',
    single.post.script.includes('step_approval_post_in'),
    single.post.script.slice(0, 200),
  );
}

// ───────────── 产物清理（只删该删的，绝不误伤） ─────────────

{
  const base = process.env.TEMP || process.env.TMP || '.';
  const tmpRoot = nodeFs.mkdtempSync(nodePath.join(base, 'canvas-clean-'));
  const oldImg = nodePath.join(tmpRoot, 'old.png');
  const newImg = nodePath.join(tmpRoot, 'new.jpg');
  const keepTxt = nodePath.join(tmpRoot, 'notes.txt');
  const keepDir = nodePath.join(tmpRoot, 'sub');
  nodeFs.writeFileSync(oldImg, 'x'.repeat(100));
  nodeFs.writeFileSync(newImg, 'y'.repeat(100));
  nodeFs.writeFileSync(keepTxt, 'z'.repeat(100));
  nodeFs.mkdirSync(keepDir, { recursive: true });
  const past = new Date(Date.now() - 10 * 86400000);
  for (const f of [oldImg, keepTxt, keepDir]) nodeFs.utimesSync(f, past, past);

  const res = mod.cleanupOldImages(tmpRoot, 7 * 86400000);
  ok('清理：删掉了过期图片（含字节数）', res.deleted === 1 && res.bytes === 100, JSON.stringify(res));
  ok('清理：过期图片确实不在了', !nodeFs.existsSync(oldImg));
  ok('清理：新的图片有保护垫（不删）', nodeFs.existsSync(newImg));
  ok('清理：非图片文件不动', nodeFs.existsSync(keepTxt));
  ok('清理：子目录不动（不递归）', nodeFs.existsSync(keepDir));
  ok('清理：不存在的目录当空处理（不抛错）', mod.cleanupOldImages(nodePath.join(tmpRoot, 'nope'), 1000).deleted === 0);

  // 临时文件清理只认自己的命名
  const mineTxt = nodePath.join(tmpRoot, 'canvas-img-n1.txt');
  const mineRes = nodePath.join(tmpRoot, 'canvas-img-n1.txt.result');
  const notMine = nodePath.join(tmpRoot, 'unrelated.png');
  for (const f of [mineTxt, mineRes, notMine]) nodeFs.writeFileSync(f, 'x');
  for (const f of [mineTxt, mineRes, notMine]) nodeFs.utimesSync(f, past, past);
  const tmpRes = mod.cleanupCanvasTmp(86400000, { dir: tmpRoot });
  ok(
    '临时清理：只删 canvas-img-* 的 .txt/.result（别的文件不碰）',
    tmpRes.deleted === 2 && !nodeFs.existsSync(mineTxt) && !nodeFs.existsSync(mineRes) && nodeFs.existsSync(notMine),
    JSON.stringify(tmpRes),
  );

  try {
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清场失败无所谓 */
  }
}

// ───────────── /asset 与 /reveal 共用的白名单校验（安全关键） ─────────────

{
  const imgDir = nodePath.join('D:', 'dsh-media', 'images');
  let realImg = null;
  try {
    realImg = nodeFs.readdirSync(imgDir).find((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)) || null;
  } catch {
    /* 目录可能不存在 */
  }
  if (realImg) {
    const good = mod.checkAssetPath(nodePath.join(imgDir, realImg));
    ok('白名单校验：白名单内的真图 → ok 且带 content-type', good.ok === true && String(good.type).startsWith('image/'), JSON.stringify(good));
  } else {
    console.log('  (跳过白名单真图断言：目录里没有图片)');
  }
  ok('白名单校验：白名单外 → 403', mod.checkAssetPath(nodePath.join(process.env.USERPROFILE || 'C:\\', '.dsh', 'memory.md')).status === 403);
  ok('白名单校验：目录穿越 → 403', mod.checkAssetPath(imgDir + '\\..\\..\\Windows\\win.ini').status === 403);
  ok('白名单校验：非图片扩展名 → 415', mod.checkAssetPath(nodePath.join(imgDir, 'x.txt')).status === 415);
  ok('白名单校验：白名单内但不存在 → 404', mod.checkAssetPath(nodePath.join(imgDir, '__missing__.png')).status === 404);
}

// ───────────── 信息位（P3）：image-edit.mjs 的 META 行 ─────────────

{
  const sample = [
    '✔ 已存: D:\\dsh-media\\images\\x.png (120 KB)',
    'META {"provider":"dashscope","model":"qwen-image-edit-plus","seconds":7.4,"size":"704x1472","images":1,"path":"D:\\\\dsh-media\\\\images\\\\x.png","cost":{"unit":"元","value":0.04,"estimated":true}}',
  ].join('\n');
  const meta = mod.parseImageMeta(sample);
  ok(
    '解析 META 行（provider / model / 耗时 / 尺寸 / 路径 / 花费）',
    !!meta &&
      meta.provider === 'dashscope' &&
      meta.model === 'qwen-image-edit-plus' &&
      Number(meta.seconds) === 7.4 &&
      String(meta.path).includes('dsh-media') &&
      Number(meta.cost && meta.cost.value) === 0.04,
    JSON.stringify(meta),
  );
  const line = mod.describeImageMeta(meta, null);
  ok(
    'META → 人类可读一行（模型 · 耗时 · 尺寸 · ≈¥）',
    /qwen-image-edit-plus/.test(line) && /7\.4s/.test(line) && /704x1472/.test(line) && /≈¥0\.04/.test(line),
    line,
  );
  ok('没有 META 时退回路径', mod.describeImageMeta(null, 'D:\\a.png') === 'D:\\a.png');
  ok('魔搭的花费显示魔粒', /1 魔粒/.test(mod.describeImageMeta({ model: 'x', cost: { unit: '魔粒', value: 1 } }, null)));
  ok('解析不出 META 不抛错', mod.parseImageMeta('普通日志一行') === null && mod.parseImageMeta('') === null);
}

// ─────────────────────── 汇总 ───────────────────────

console.log('\n' + '='.repeat(52));
if (failures.length === 0) {
  console.log('全部通过：' + pass + ' 项断言 \u2713');
  process.exit(0);
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项：');
  for (const f of failures) console.log('  \u2717 ' + f);
  process.exit(1);
}
