/**
 * dsh-canvas —— 「✨ AI 生成工作流」的核心：一句话需求 → 画布图 JSON。
 *
 * 这里刻意只放**纯函数**（提示词 / 脚本构造 / 抠 JSON / 规整 + 自动布局），
 * 这样它们能在 `verify-offline.mjs` 里离线测；真正"问 AI"的 IO 留在 index.js 的路由里。
 *
 * @module dsh-canvas/generate
 */

/**
 * 给模型的指令。
 * 节点类型和字段全部写死 —— 不然它自由发挥出编译器不认的东西，用户只会看到一句天书报错。
 */
export const GENERATE_SYSTEM = [
  '你是「画布工作流」设计器。把用户的一句话需求翻译成一张有向图，**只输出 JSON**。',
  '不要解释、不要 markdown 代码块、不要任何多余文字。',
  '',
  'JSON 结构：',
  '{"name":"kebab-case-名字","nodes":[...],"edges":[...]}',
  '',
  '节点（type 只能从这五种里选）：',
  '- {"id":"n1","type":"trigger","data":{"prompt":"流程的初始文本"}}    ← 恰好 1 个，作为起点',
  '- {"id":"n2","type":"agent","data":{"prompt":"交给子代理的提示词","label":"短名字"}}',
  '- {"id":"n3","type":"code","data":{"code":"return Math.random();"}}   ← 内联 JS，用 return 交出本节点的值',
  '- {"id":"n4","type":"condition","data":{"expr":"inputs.n2 > 50","label":"短名字"}}  ← 必须是 JS 表达式',
  '- {"id":"n5","type":"output","data":{}}                               ← 至少 1 个，作为终点',
  '',
  '连线：{"id":"e1","from":"n1","to":"n2"}',
  'condition 的出边要带分支：{"id":"e2","from":"n4","to":"n6","branch":"then"}，另一条用 "else"。',
  '',
  '硬性规则：',
  '1. condition 的 expr 是 **JS 表达式**，绝对不能用中文句子；引用上游必须写 inputs.<节点id>。',
  '2. code 的 code 是 **JS 语句**，用 return 交出本节点的值；上游放在 inputs 对象里（如 inputs.n2）。',
  '3. agent 的提示词里可以用 {{节点id}} 引用上游输出。',
  '4. position 可以省略，系统会自动排层。',
  '5. 节点总数不要超过 8 个。',
].join('\n');

/**
 * 构造「问一次 AI」的 workflow 脚本。
 *
 * 借道内核的 `workflow` 工具执行 `agent()` —— 和画布运行时走同一条路
 * （`workflowEngine` 在 agent realm 里，全局插件拿不到，详见 index.js 文件头）。
 * 指令与需求都通过 `args` 传进去，避免字符串拼接时的转义地狱。
 */
export function buildGenerateScript() {
  return [
    '// dsh-canvas 生成器：问一次子代理，要它吐出图 JSON',
    'const spec = args && typeof args.spec === "string" ? args.spec : "";',
    'const instructions = args && typeof args.instructions === "string" ? args.instructions : "";',
    'const raw = await agent(instructions + "\\n\\n用户需求：" + spec, { label: "画布生成" });',
    'return { raw: String(raw) };',
  ].join('\n');
}

/**
 * 从模型输出里抠出图对象。
 * 容忍三种情况：纯 JSON、```json 代码块、JSON 前后夹着解释文字。
 * @param rawText 模型返回的原文
 * @returns 解析出的对象
 * @throws 解析不出来时抛错（调用方转成用户可读的提示）
 */
export function extractGraph(rawText) {
  const text = String(rawText ?? '');
  const candidates = [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) candidates.push(fenced[1]);

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate.trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error('模型没有输出可解析的 JSON');
}

/** 节点类型白名单（与编译器保持一致）。 */
const TYPES = new Set(['trigger', 'agent', 'code', 'condition', 'output']);

/**
 * 规整模型给的图：补 id、去重、校验类型、去掉悬空边，缺 position 时自动分层排版。
 * @param raw extractGraph 的结果
 * @returns 可以直接喂给 compile() 的 graph
 */
export function normalizeGraph(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  if (rawNodes.length === 0) throw new Error('模型没有给出任何节点');

  const seen = new Set();
  const nodes = [];
  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i] || {};
    let id = typeof n.id === 'string' && n.id !== '' ? n.id.replace(/[^A-Za-z0-9_-]/g, '') : '';
    if (id === '') id = `n${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);

    const data = n.data && typeof n.data === 'object' ? n.data : {};
    const pos = n.position && typeof n.position === 'object' ? n.position : null;
    const x = pos && Number.isFinite(Number(pos.x)) ? Number(pos.x) : null;
    const y = pos && Number.isFinite(Number(pos.y)) ? Number(pos.y) : null;
    nodes.push({
      id,
      type: TYPES.has(n.type) ? n.type : 'agent',
      position: x === null || y === null ? null : { x, y },
      data,
    });
    if (typeof data.label !== 'string' && (nodes[nodes.length - 1].type === 'agent' || nodes[nodes.length - 1].type === 'condition')) {
      nodes[nodes.length - 1].data = { ...data, label: id };
    }
  }

  const edgeSeen = new Set();
  const edges = [];
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
  for (const e of rawEdges) {
    const from = String((e && e.from) ?? '');
    const to = String((e && e.to) ?? '');
    if (!seen.has(from) || !seen.has(to) || from === to) continue;
    const key = `${from}->${to}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    const edge = { id: `e${edges.length + 1}`, from, to };
    if (e.branch === 'else') edge.branch = 'else';
    edges.push(edge);
  }

  layout(nodes, edges);

  return {
    version: 1,
    name: typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name.trim().slice(0, 40) : 'ai-generated',
    nodes,
    edges,
  };
}

/**
 * 分层自动排版：只在有节点缺 position 时生效。
 * 层号 = 从起点算起的**最长**前驱链长度，同层纵向排开。
 */
function layout(nodes, edges) {
  if (!nodes.some((n) => n.position === null)) return;

  const NODE_W = 200;
  const NODE_H = 74;
  const out = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (!out.has(e.from) || !indeg.has(e.to)) continue;
    out.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }

  const layer = new Map();
  const queue = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);

  let guard = 0;
  while (queue.length > 0 && guard < 1000) {
    guard += 1;
    const id = queue.shift();
    const depth = layer.get(id) ?? 0;
    for (const next of out.get(id)) {
      layer.set(next, Math.max(layer.get(next) ?? 0, depth + 1));
      indeg.set(next, (indeg.get(next) || 0) - 1);
      if ((indeg.get(next) || 0) === 0) queue.push(next);
    }
  }

  const byLayer = new Map();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n);
  }
  for (const [l, list] of byLayer) {
    list.forEach((n, i) => {
      if (n.position === null) {
        n.position = { x: 30 + l * (NODE_W + 60), y: 60 + i * (NODE_H + 60) };
      }
    });
  }
  for (const n of nodes) if (n.position === null) n.position = { x: 30, y: 60 };
}
