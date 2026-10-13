/**
 * dsh-canvas — 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）。
 *
 * ## 是什么
 * 一个类 n8n / Dify 的**可视化画布**：拖节点、连线、点运行、节点实时高亮。
 * 外壳自研（自绘 SVG，零第三方依赖），引擎用内核现成的 workflow。
 *
 * ## P0 范围（刻意不做的事）
 * 做：加节点 / 拖节点 / 连线 / 选中删除 / ▶运行 ■停止 / 节点状态高亮 / 存盘。
 * 不做：缩放、框选、吸附对齐、右键菜单、属性面板（P1+）。
 *
 * ## 节点状态怎么来（关键）
 * host 把内核的 `workflow/*` 事件转成 SSE：
 *   · `workflow/agent-start` 带 `label` → 按 **label** 点亮对应节点（比 seq 稳）；
 *   · `workflow/agent-end` 带 `outcome` → 绿(completed) / 红(failed) / 灰(cancelled)；
 *   · `canvas/result` → 底部显示最终返回值。
 *
 * ## 防御姿态（吃过亏）
 * 组件任何异常都不该让整个 slot 崩 —— 曾经有插件就是崩在 slot 里、
 * 把隔壁的「模式」按钮一起带走的（`dsh-webui-prompt-optimizer`）。
 * 所以：网络/SSE 全包 try、渲染只依赖自有 state、apply 双重 try。
 */
(function () {
  'use strict';

  /** Host 路由前缀。 */
  var ROUTE = '/api/dsh-canvas';
  /** 样式标记。 */
  var STYLE_FLAG = 'data-dsh-canvas';

  /** 节点尺寸（画布坐标）。 */
  var NODE_W = 200;
  var NODE_H = 74;
  /** 画布可视尺寸。 */
  var STAGE_W = 900;
  var STAGE_H = 460;

  /** 类型配色。 */
  var TYPE_STYLE = {
    trigger: { fill: '#e8f6ec', stroke: '#2f9e5f', tag: '起点' },
    agent: { fill: '#e9f0fd', stroke: '#3f6ec4', tag: '子代理' },
    image: { fill: '#eaf7ff', stroke: '#1f7fa8', tag: '图像' },
    code: { fill: '#fdf6e6', stroke: '#b8862f', tag: '代码' },
    condition: { fill: '#fdecec', stroke: '#c4533f', tag: '判断' },
    parallel: { fill: '#eef7fb', stroke: '#2f7f9e', tag: '并行' },
    approval: { fill: '#e6f7f5', stroke: '#1f8a7a', tag: '审批' },
    output: { fill: '#f3ecfd', stroke: '#7b53c4', tag: '输出' },
  };

  /** 状态环配色。 */
  var STATUS_RING = {
    running: '#e0a52b',
    done: '#2f9e5f',
    failed: '#c0392b',
    cancelled: '#8a8f9c',
  };

  var CSS = [
    '.dsh-canvas-root{position:fixed;right:18px;bottom:18px;z-index:60;',
    'font-family:var(--dsw-font-family,system-ui,sans-serif);pointer-events:auto}',
    '.dsh-canvas-fab{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 14px;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:999px;',
    'background:var(--dsw-alias-button-elevated-fill,rgba(255,255,255,.92));',
    'color:var(--dsw-alias-label-primary,#172347);font-size:13px;cursor:pointer;',
    'box-shadow:0 6px 20px rgba(13,29,70,.18)}',
    '.dsh-canvas-fab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
    '.dsh-canvas-panel{position:fixed;display:flex;flex-direction:column;overflow:hidden;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:14px;',
    // 皮肤可能把 --dsw-alias-bg-layer-2 定义成半透明甚至透明 → 面板会"透"出后面的对话。
    // 所以先铺一层**不透明底色**，再用那个变量叠一层（保住主题色，又不透字）。
    'background-color:#fffdf8;',
    'background-image:linear-gradient(var(--dsw-alias-bg-layer-2,#fffdf8f2),var(--dsw-alias-bg-layer-2,#fffdf8f2));',
    'color:var(--dsw-alias-label-primary,#172347);',
    'box-shadow:0 18px 48px rgba(13,29,70,.28)}',
    '.dsh-canvas-head{display:flex;align-items:center;gap:6px;padding:9px 12px;flex-wrap:wrap;',
    'border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));font-size:13px}',
    '.dsh-canvas-head .sp{flex:1}',
    '.dsh-canvas-head button{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
    'background:transparent;cursor:pointer;font-size:12px;padding:4px 9px;border-radius:8px;',
    'color:var(--dsw-alias-label-primary,#172347)}',
    '.dsh-canvas-head button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
    '.dsh-canvas-head button[disabled]{opacity:.45;cursor:not-allowed}',
    '.dsh-canvas-head button.primary{background:linear-gradient(145deg,#6079b5,#294587);color:#fff;',
    'border-color:#294587}',
    '.dsh-canvas-title{font-weight:600;margin-right:4px}',
    '.dsh-canvas-stagebox{flex:1 1 auto;min-height:160px;overflow:auto;background:',
    'repeating-linear-gradient(0deg,transparent,transparent 23px,rgba(127,127,127,.08) 24px),',
    'repeating-linear-gradient(90deg,transparent,transparent 23px,rgba(127,127,127,.08) 24px)}',
    '.dsh-canvas-svg{display:block;touch-action:none}',
    // 日志区高度由「分隔条拖动」决定（原来是百分比上限，小面板里会把画布挤没）
    '.dsh-canvas-foot{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));',
    'padding:8px 12px;font-size:12px;min-height:44px;overflow:auto;',
    'font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;',
    'color:var(--dsw-alias-label-secondary,#4d5d7f)}',
    '.dsh-canvas-logsplit{flex:0 0 auto;height:8px;cursor:row-resize;',
    'background:var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
    '.dsh-canvas-logsplit:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(43,108,255,.35))}',
    // 窄屏（手机）：画布区再压一点，让工具条也有地方站
    '@media (max-width:700px){',
    '.dsh-canvas-stagebox{min-height:110px}',
    '.dsh-canvas-foot{padding:6px 8px;font-size:11px}',
    '.dsh-canvas-head{gap:4px;padding:6px 8px}',
    '}',
    // v3 硬判定兜底：body.dsh-canvas-touch 由 apply() 按 maxTouchPoints / UA 打上，
    // 跟上面那条媒体查询互为保险（手机浏览器谎报 hover/pointer 时仍然能命中）。
    'body.dsh-canvas-touch .dsh-canvas-root{right:0;bottom:auto;top:44%;z-index:55}',
    'body.dsh-canvas-touch .dsh-canvas-fab{width:44px;height:44px;padding:0;border-radius:999px 0 0 999px;',
    'font-size:0;justify-content:center;opacity:.9;box-shadow:-2px 4px 16px rgba(13,29,70,.24)}',
    'body.dsh-canvas-touch .dsh-canvas-fab::before{content:"🎨";font-size:19px;line-height:1}',
    // 手机（真触屏）才把悬浮球挪到右边缘垂直居中、缩成圆形图标：会话里
    // 「提问 / 审批卡片」的操作按钮（跳过 / 通过 / 提交）就在右下角，原悬浮球会盖住它们。
    // 用 (hover:none)+(pointer:coarse) 限定真触屏 —— 桌面端窗口再窄也保留原来的
    // 「🎨 画布」胶囊按钮。实测量过：390x844 触屏下圆球落 (346,371)，不进底部按钮带。
    '@media (hover:none) and (pointer:coarse){',
    '.dsh-canvas-root{right:0;bottom:auto;top:44%;z-index:55}',
    '.dsh-canvas-fab{width:44px;height:44px;padding:0;border-radius:999px 0 0 999px;',
    'font-size:0;justify-content:center;opacity:.9;box-shadow:-2px 4px 16px rgba(13,29,70,.24)}',
    '.dsh-canvas-fab::before{content:"🎨";font-size:19px;line-height:1}',
    '}',
    '.dsh-canvas-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#6f7c99);padding:0 12px 8px}',
    '.dsh-canvas-inspector{display:flex;gap:8px;align-items:flex-start;padding:8px 12px;',
    'border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.25));font-size:12px}',
    '.dsh-canvas-inspector .tag{flex:none;color:var(--dsw-alias-label-tertiary,#6f7c99);padding-top:6px;white-space:nowrap}',
    '.dsh-canvas-inspector input,.dsh-canvas-inspector textarea{box-sizing:border-box;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:8px;padding:5px 8px;',
    'background:var(--dsw-specific-input-major,rgba(255,255,255,.8));color:inherit;font-size:12px;',
    'font-family:inherit;resize:vertical}',
    '.dsh-canvas-inspector input{width:130px;flex:none}',
    '.dsh-canvas-inspector textarea{flex:1;min-width:120px}',
    '.dsh-canvas-loadlist{border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.25));',
    'max-height:150px;overflow:auto;padding:6px 12px;font-size:12px}',
    '.dsh-canvas-loadlist .item{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:8px;cursor:pointer}',
    '.dsh-canvas-loadlist .item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
    '.dsh-canvas-loadlist .grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-canvas-loadlist .dim{color:var(--dsw-alias-label-tertiary,#6f7c99);font-size:11px}',
    '.dsh-canvas-loadlist .item button{border:none;background:transparent;cursor:pointer;font-size:13px;',
    'color:var(--dsw-alias-label-tertiary,#6f7c99);padding:2px 6px;border-radius:6px;line-height:1}',
    '.dsh-canvas-loadlist .item button:hover{background:rgba(192,57,43,.14);color:#c0392b}',
    // ── 八向拖拽热区（位置与光标都在这）──
    '.dsh-canvas-rs{position:absolute;z-index:6;touch-action:none}',
    '.dsh-canvas-rs-n{top:0;left:12px;right:12px;height:6px;cursor:ns-resize}',
    '.dsh-canvas-rs-s{bottom:0;left:12px;right:12px;height:6px;cursor:ns-resize}',
    '.dsh-canvas-rs-w{left:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}',
    '.dsh-canvas-rs-e{right:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}',
    '.dsh-canvas-rs-nw{left:0;top:0;width:14px;height:14px;cursor:nwse-resize}',
    '.dsh-canvas-rs-ne{right:0;top:0;width:14px;height:14px;cursor:nesw-resize}',
    '.dsh-canvas-rs-sw{left:0;bottom:0;width:14px;height:14px;cursor:nesw-resize}',
    '.dsh-canvas-rs-se{right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize}',
    // ── 各部件在面板里的伸缩规则（窗口拉大拉小都不错位）──
    '.dsh-canvas-head,.dsh-canvas-hint,.dsh-canvas-inspector,.dsh-canvas-loadlist{flex:none}',
    '.dsh-canvas-result{flex:none;margin:0 12px 8px;padding:10px 12px;border-radius:10px;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
    'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.6))}',
    '.dsh-canvas-result[data-state="completed"]{border-color:#2f9e5f66;background:#f2fbf5}',
    '.dsh-canvas-result[data-state="error"]{border-color:#c0392b66;background:#fdf3f2}',
    '.dsh-canvas-result .rs-head{display:flex;align-items:center;gap:8px;font-size:11px;',
    'color:var(--dsw-alias-label-tertiary,#6f7c99);margin-bottom:6px}',
    '.dsh-canvas-result .rs-body{font-size:14px;line-height:1.6;white-space:pre-wrap;',
    'word-break:break-word;max-height:150px;overflow:auto;user-select:text;cursor:text}',
    '.dsh-canvas-result .rs-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#6f7c99);margin-top:6px}',
    '.dsh-canvas-result button{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
    'background:transparent;cursor:pointer;font-size:11px;padding:2px 7px;border-radius:6px;color:inherit}',
    '.dsh-canvas-node{cursor:grab}',
    '.dsh-canvas-node text{user-select:none;pointer-events:none}',
    '@keyframes dsh-canvas-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '.dsh-canvas-pulse{animation:dsh-canvas-pulse 1.1s ease-in-out infinite}',
    '@media (prefers-reduced-motion:reduce){.dsh-canvas-pulse{animation:none}}',
  ].join('');

  // ───────────────────────── 纯函数（可离线测试）─────────────────────────

  /** 默认演示图：正好是 P0 验收要的 trigger → agent → output。 */
  function defaultGraph() {
    return {
      version: 1,
      name: '小鲸演示流',
      nodes: [
        { id: 'n1', type: 'trigger', position: { x: 60, y: 150 }, data: { prompt: '用一句话介绍你自己' } },
        { id: 'n2', type: 'agent', position: { x: 340, y: 150 }, data: { prompt: '把这句话改写得更可爱一点', label: '改写' } },
        { id: 'n3', type: 'output', position: { x: 620, y: 150 }, data: {} },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' },
      ],
    };
  }

  /** 运行历史存在浏览器的 localStorage 里（纯前端，不占插件目录）。 */
  var HISTORY_KEY = 'dsh-canvas:history';
  var HISTORY_MAX = 30;

  function loadHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch (error) {
      /* 存不下就算了，不该影响画布 */
    }
  }

  /** 时间戳 → 好读的短时间。 */
  function shortTime(ts) {
    try {
      var d = new Date(ts);
      var pad = function (n) {
        return n < 10 ? '0' + n : String(n);
      };
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    } catch (error) {
      return '—';
    }
  }

  /**
   * 把「外来」的画布（导入的文件 / 别处来的 JSON）规整成画布能安全渲染的形状。
   * 重点是**补齐 position** —— 缺了它渲染期会抛 TypeError，而组件一抛错整个 slot 就崩，
   * 会把别的插件 UI 一起拖垮（本项目真实发生过）。
   */
  function normalizeIncoming(raw) {
    var g = raw && typeof raw === 'object' ? raw : {};
    var nodes = Array.isArray(g.nodes) ? g.nodes : [];
    var edges = Array.isArray(g.edges) ? g.edges : [];
    var seen = {};
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] || {};
      var id = typeof n.id === 'string' && n.id !== '' ? n.id : 'n' + (i + 1);
      while (seen[id]) id = id + '_';
      seen[id] = true;
      var pos = n.position && typeof n.position === 'object' ? n.position : null;
      var px = pos && isFinite(Number(pos.x)) ? Number(pos.x) : null;
      var py = pos && isFinite(Number(pos.y)) ? Number(pos.y) : null;
      out.push({
        id: id,
        type: typeof n.type === 'string' ? n.type : 'agent',
        position: px === null || py === null ? { x: 40 + (i % 4) * 240, y: 60 + Math.floor(i / 4) * 150 } : { x: px, y: py },
        data: n.data && typeof n.data === 'object' ? n.data : {},
      });
    }
    var eOut = [];
    for (var j = 0; j < edges.length; j++) {
      var e = edges[j] || {};
      if (!seen[e.from] || !seen[e.to] || e.from === e.to) continue;
      var edge = { id: typeof e.id === 'string' ? e.id : 'e' + (j + 1), from: e.from, to: e.to };
      if (typeof e.expr === 'string' && e.expr.trim() !== '') edge.expr = e.expr;
      if (e.branch === 'else') edge.branch = 'else';
      eOut.push(edge);
    }
    return {
      version: 1,
      name: typeof g.name === 'string' && g.name.trim() !== '' ? g.name.trim().slice(0, 60) : 'imported',
      nodes: out,
      edges: eOut,
    };
  }

  /**
   * 内置模板 —— 每个都是**能直接点运行**的完整图。
   * 用 build() 现造一份：避免两个模板共享同一个对象引用被改坏。
   */
  var TEMPLATES = [
    {
      id: 'image-tune',
      name: '🎨 可控改图（图像节点 + 两关审批）',
      note: '出图 → 🚦看 → 改图 → 🚦再看 → 改图 → 输出（每关都能写意见）',
      build: function () {
        return {
          version: 1,
          name: 'image-tune',
          nodes: [
            {
              id: 'seed',
              type: 'trigger',
              position: { x: 30, y: 240 },
              data: { prompt: '一只在深海里游泳的鲸鱼娘，动漫风格，白蓝色长发' },
            },
            { id: 'gen', type: 'image', position: { x: 270, y: 240 }, data: { prompt: '{{seed}}', label: '出图' } },
            {
              id: 'g1',
              type: 'approval',
              position: { x: 510, y: 240 },
              data: { note: '第一版好了。满意就点「通过」；想改就写一句意见（例：把背景换成星空）' },
            },
            {
              id: 'edit1',
              type: 'image',
              position: { x: 750, y: 240 },
              data: {
                prompt: '按上面【主人的修改意见】改这张图（人物、发型、姿势、构图保持不变）。没写意见就把画面再精修一版',
                image: '{{上一段}}',
                out: 'D:\\dsh-media\\images',
                label: '改图1',
              },
            },
            {
              id: 'g2',
              type: 'approval',
              position: { x: 990, y: 240 },
              data: { note: '还要再改吗？写意见就继续改；满意就点「通过」看成品' },
            },
            {
              id: 'edit2',
              type: 'image',
              position: { x: 1230, y: 240 },
              data: {
                prompt: '按上面【主人的修改意见】再改一版（保持人物一致）',
                image: '{{上一段}}',
                out: 'D:\\dsh-media\\images',
                label: '改图2',
              },
            },
            { id: 'out', type: 'output', position: { x: 1470, y: 240 }, data: {} },
          ],
          edges: [
            { id: 'e1', from: 'seed', to: 'gen' },
            { id: 'e2', from: 'gen', to: 'g1' },
            { id: 'e3', from: 'g1', to: 'edit1' },
            { id: 'e4', from: 'edit1', to: 'g2' },
            { id: 'e5', from: 'g2', to: 'edit2' },
            { id: 'e6', from: 'edit2', to: 'out' },
          ],
        };
      },
    },
    {
      id: 'quick-qa',
      name: '① 一句话问答',
      note: '起点 → 子代理 → 输出（最简单的三段）',
      build: function () {
        return {
          version: 1,
          name: 'quick-qa',
          nodes: [
            { id: 'n1', type: 'trigger', position: { x: 40, y: 220 }, data: { prompt: '用一句话介绍你自己' } },
            { id: 'n2', type: 'agent', position: { x: 320, y: 220 }, data: { prompt: '根据上面的内容写一句回答', label: '回答' } },
            { id: 'o', type: 'output', position: { x: 600, y: 220 }, data: {} },
          ],
          edges: [
            { id: 'e1', from: 'n1', to: 'n2' },
            { id: 'e2', from: 'n2', to: 'o' },
          ],
        };
      },
    },
    {
      id: 'grade-three',
      name: '② 三档分级',
      note: '代码生成随机数 → 判断分三路（>66 / >33 / 兜底）',
      build: function () {
        return {
          version: 1,
          name: 'grade-three',
          nodes: [
            { id: 'n1', type: 'trigger', position: { x: 30, y: 260 }, data: { prompt: '50' } },
            { id: 'n2', type: 'code', position: { x: 240, y: 260 }, data: { code: 'return Math.floor(Math.random() * 100) + 1;' } },
            { id: 'n3', type: 'condition', position: { x: 450, y: 260 }, data: { label: '打分' } },
            { id: 'a', type: 'agent', position: { x: 700, y: 80 }, data: { prompt: '打了 {{n2}} 分，很高！用一句话夸夸，20 字以内', label: '高分' } },
            { id: 'b', type: 'agent', position: { x: 700, y: 260 }, data: { prompt: '打了 {{n2}} 分，中等。用一句话说说，20 字以内', label: '中分' } },
            { id: 'c', type: 'agent', position: { x: 700, y: 440 }, data: { prompt: '打了 {{n2}} 分，偏低。用一句话安慰，20 字以内', label: '低分' } },
            { id: 'o', type: 'output', position: { x: 960, y: 260 }, data: {} },
          ],
          edges: [
            { id: 'e1', from: 'n1', to: 'n2' },
            { id: 'e2', from: 'n2', to: 'n3' },
            { id: 'e3', from: 'n3', to: 'a', expr: 'Number(inputs.n2) > 66' },
            { id: 'e4', from: 'n3', to: 'b', expr: 'Number(inputs.n2) > 33' },
            { id: 'e5', from: 'n3', to: 'c', branch: 'else' },
            { id: 'e6', from: 'a', to: 'o' },
            { id: 'e7', from: 'b', to: 'o' },
            { id: 'e8', from: 'c', to: 'o' },
          ],
        };
      },
    },
    {
      id: 'parallel-write',
      name: '③ 并行写手',
      note: '并行节点同时跑两路子代理，再汇合',
      build: function () {
        return {
          version: 1,
          name: 'parallel-write',
          nodes: [
            { id: 'n1', type: 'trigger', position: { x: 30, y: 240 }, data: { prompt: '主题：深海' } },
            { id: 'p', type: 'parallel', position: { x: 250, y: 240 }, data: {} },
            { id: 'a', type: 'agent', position: { x: 480, y: 120 }, data: { prompt: '用一句话描写主题', label: '描写一' } },
            { id: 'b', type: 'agent', position: { x: 480, y: 360 }, data: { prompt: '再用一句话描写主题', label: '描写二' } },
            { id: 'o', type: 'output', position: { x: 740, y: 240 }, data: {} },
          ],
          edges: [
            { id: 'e1', from: 'n1', to: 'p' },
            { id: 'e2', from: 'p', to: 'a' },
            { id: 'e3', from: 'p', to: 'b' },
            { id: 'e4', from: 'a', to: 'o' },
            { id: 'e5', from: 'b', to: 'o' },
          ],
        };
      },
    },
    {
      id: 'chain-grade',
      name: '④ 链式判断',
      note: '判断的「否」接下一个判断 —— if / else if / else',
      build: function () {
        return {
          version: 1,
          name: 'chain-grade',
          nodes: [
            { id: 'n1', type: 'trigger', position: { x: 30, y: 300 }, data: { prompt: '72' } },
            { id: 'n2', type: 'code', position: { x: 220, y: 300 }, data: { code: 'return Math.floor(Math.random() * 100) + 1;' } },
            { id: 'n3', type: 'condition', position: { x: 410, y: 300 }, data: { label: '大？' } },
            { id: 'n4', type: 'agent', position: { x: 660, y: 100 }, data: { prompt: '抽到 {{n2}}，是个大数！用一句话夸张地夸夸它', label: '夸大的' } },
            { id: 'n5', type: 'condition', position: { x: 660, y: 320 }, data: { label: '中？' } },
            { id: 'n6', type: 'agent', position: { x: 900, y: 300 }, data: { prompt: '抽到 {{n2}}，不大不小。用一句话聊聊它', label: '聊中的' } },
            { id: 'n7', type: 'agent', position: { x: 660, y: 520 }, data: { prompt: '抽到 {{n2}}，有点小。用一句话安慰它', label: '安慰小的' } },
            { id: 'o', type: 'output', position: { x: 1150, y: 300 }, data: {} },
          ],
          edges: [
            { id: 'e1', from: 'n1', to: 'n2' },
            { id: 'e2', from: 'n2', to: 'n3' },
            { id: 'e3', from: 'n3', to: 'n4', expr: 'Number(inputs.n2) > 66' },
            { id: 'e4', from: 'n3', to: 'n5', branch: 'else' },
            { id: 'e5', from: 'n5', to: 'n6', expr: 'Number(inputs.n2) > 33' },
            { id: 'e6', from: 'n5', to: 'n7', branch: 'else' },
            { id: 'e7', from: 'n4', to: 'o' },
            { id: 'e8', from: 'n6', to: 'o' },
            { id: 'e9', from: 'n7', to: 'o' },
          ],
        };
      },
    },
  ];

  /** 下一个可用节点 id（n1, n2, …）。 */
  function nextNodeId(graph) {
    var max = 0;
    for (var i = 0; i < graph.nodes.length; i++) {
      var m = /^n(\d+)$/.exec(String(graph.nodes[i].id));
      if (m) max = Math.max(max, Number(m[1]));
    }
    return 'n' + (max + 1);
  }

  /** 把节点往后顺延，避免新节点压在旧节点上。 */
  function freeSpot(graph) {
    var y = 60;
    for (var i = 0; i < graph.nodes.length; i++) {
      y = Math.max(y, graph.nodes[i].position.y + NODE_H + 40);
    }
    return { x: 100, y: y > STAGE_H - NODE_H - 20 ? 60 : y };
  }

  /** 连线路径（三次贝塞尔，右出左进）。 */
  function edgePath(fromNode, toNode) {
    var x1 = fromNode.position.x + NODE_W;
    var y1 = fromNode.position.y + NODE_H / 2;
    var x2 = toNode.position.x;
    var y2 = toNode.position.y + NODE_H / 2;
    var dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
  }

  /**
   * 从工作流返回值里挖出「人看得懂的那句话」。
   *
   * 实际结构是层层嵌套的：
   *   value = { runId, agentsStarted, result: { result: "正文", outputs: {...}, __canvas: {...} } }
   * 所以往下钻两层，把最里面那个字符串拎出来；钻不到就退回格式化 JSON。
   */
  function extractMainResult(value) {
    if (value === null || value === undefined) return '（这次没有返回值）';
    if (typeof value === 'string') return value;
    var v = value;
    for (var depth = 0; depth < 4; depth++) {
      if (v === null || v === undefined) break;
      if (typeof v === 'string') return v;
      if (typeof v === 'object') {
        if (typeof v.result === 'string' && depth >= 1) return v.result;
        if (v.result !== undefined) {
          v = v.result;
          continue;
        }
      }
      break;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch (e) {
      return String(value);
    }
  }

  /**
   * 贝塞尔连线上的某一点（t = 0.5 是正中）。
   * 判断节点的多条出边共用一个起点，标签如果都放正中就会叠在一起 ——
   * 所以按边的序号给不同的 t，沿边错开。
   */
  function edgeMidpoint(fromNode, toNode, t) {
    var x1 = fromNode.position.x + NODE_W;
    var y1 = fromNode.position.y + NODE_H / 2;
    var x2 = toNode.position.x;
    var y2 = toNode.position.y + NODE_H / 2;
    var dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    var c1x = x1 + dx;
    var c2x = x2 - dx;
    var tt = typeof t === 'number' ? t : 0.5;
    var mt = 1 - tt;
    var x = mt * mt * mt * x1 + 3 * mt * mt * tt * c1x + 3 * mt * tt * tt * c2x + tt * tt * tt * x2;
    var y = mt * mt * mt * y1 + 3 * mt * mt * tt * y1 + 3 * mt * tt * tt * y2 + tt * tt * tt * y2;
    return { x: Math.round(x), y: Math.round(y) };
  }

  // ───────────────────────── 组件 ─────────────────────────

  window.__ModuleLoader__.load({
    id: 'dsh-canvas',
    factory: function (require) {
      var React = require('react');

      function insertStyle() {
        if (document.querySelector('style[' + STYLE_FLAG + ']')) return;
        var el = document.createElement('style');
        el.setAttribute(STYLE_FLAG, '1');
        el.textContent = CSS;
        document.head.appendChild(el);
      }

      /** 画布里的一个节点。 */
      function NodeShape(props) {
        var node = props.node;
        var style = TYPE_STYLE[node.type] || TYPE_STYLE.agent;
        var status = props.status;
        var ring = status ? STATUS_RING[status] : null;
        var label = (node.data && node.data.label) || node.id;
        var nodeData = node.data || {};
        var prompt =
          node.type === 'code'
            ? nodeData.code || '(空代码)'
            : node.type === 'condition'
              ? nodeData.expr || '(空条件)'
              : node.type === 'parallel'
                ? '（同时执行下面几条分叉）'
                : node.type === 'approval'
                  ? nodeData.note || '（等审批）'
              : nodeData.prompt || (node.type === 'output' ? '(工作流返回值)' : '(未填提示词)');
        var short = prompt.length > 22 ? prompt.slice(0, 22) + '…' : prompt;

        var children = [
          React.createElement('rect', {
            key: 'bg',
            x: 0,
            y: 0,
            width: NODE_W,
            height: NODE_H,
            rx: 12,
            fill: style.fill,
            stroke: props.selected ? '#1f2f5e' : style.stroke,
            strokeWidth: props.selected ? 2.6 : 1.6,
          }),
          React.createElement('text', { key: 'tag', x: 12, y: 18, fontSize: 10, fill: style.stroke }, style.tag),
          React.createElement('text', { key: 'label', x: 12, y: 36, fontSize: 13, fontWeight: 600, fill: '#172347' }, label),
          React.createElement('text', { key: 'prompt', x: 12, y: 55, fontSize: 11, fill: '#5b6b8c' }, short),
        ];

        // 图像节点的产物缩略图（本地路径浏览器读不了，走 host 的 /asset 白名单路由）
        if (typeof props.preview === 'string' && props.preview !== '') {
          children.push(
            React.createElement('image', {
              key: 'preview',
              href: ROUTE + '/asset?path=' + encodeURIComponent(props.preview),
              x: NODE_W - 70,
              y: 8,
              width: 62,
              height: 58,
              preserveAspectRatio: 'xMidYMid slice',
              style: { pointerEvents: 'none' },
            }),
          );
          // 盖一层透明热区：**双击看高清大图**（顺便把拖动事件拦住）
          children.push(
            React.createElement('rect', {
              key: 'preview-hit',
              x: NODE_W - 70,
              y: 8,
              width: 62,
              height: 58,
              fill: 'transparent',
              style: { cursor: 'zoom-in' },
              onPointerDown: function (event) {
                event.stopPropagation();
              },
              onDoubleClick: function (event) {
                event.stopPropagation();
                if (props.onOpenPreview) props.onOpenPreview(props.preview);
              },
            }),
          );
          children.push(
            React.createElement(
              'text',
              { key: 'preview-hint', x: NODE_W - 70, y: 72, fontSize: 9, fill: '#1f7fa8' },
              '双击看大图',
            ),
          );
        }

        // 信息位：模型 · 耗时 · 尺寸 · 花费（host 从 image-edit.mjs 的 META 行解析来的）
        if (typeof props.detail === 'string' && props.detail !== '' && props.detail.indexOf(':\\') < 0) {
          var info = props.detail.length > 34 ? props.detail.slice(0, 33) + '…' : props.detail;
          children.push(
            React.createElement(
              'text',
              { key: 'detail', x: 12, y: 68, fontSize: 9, fill: '#2f6f92' },
              info,
            ),
          );
        }

        if (ring) {
          children.push(
            React.createElement('rect', {
              key: 'ring',
              x: -4,
              y: -4,
              width: NODE_W + 8,
              height: NODE_H + 8,
              rx: 15,
              fill: 'none',
              stroke: ring,
              strokeWidth: 3,
              className: status === 'running' ? 'dsh-canvas-pulse' : undefined,
            }),
          );
        }

        // 连线起点（右侧圆点）
        children.push(
          React.createElement('circle', {
            key: 'port',
            cx: NODE_W,
            cy: NODE_H / 2,
            r: 7,
            fill: '#fff',
            stroke: style.stroke,
            strokeWidth: 2,
            style: { cursor: 'crosshair' },
            onPointerDown: function (event) {
              event.stopPropagation();
              props.onPortDown(node.id, event);
            },
          }),
        );

        return React.createElement(
          'g',
          {
            className: 'dsh-canvas-node',
            transform: 'translate(' + node.position.x + ',' + node.position.y + ')',
            onPointerDown: function (event) {
              props.onNodeDown(node.id, event);
            },
            onPointerUp: function (event) {
              props.onNodeUp(node.id, event);
            },
          },
          children,
        );
      }

      /** 整个画布面板。 */
      function CanvasWidget() {
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];

        var graphState = React.useState(defaultGraph);
        var graph = graphState[0];
        var setGraph = graphState[1];

        var selectedState = React.useState(null);
        var selected = selectedState[0];
        var setSelected = selectedState[1];

        // 连线也有自己的选中态（和节点互斥）
        var selectedEdgeState = React.useState(null);
        var selectedEdge = selectedEdgeState[0];
        var setSelectedEdge = selectedEdgeState[1];

        var statusState = React.useState({});
        var status = statusState[0];
        var setStatus = statusState[1];

        /** 图像节点的产物缩略图：nodeId → 本地绝对路径（前端转成 /asset URL 给 SVG <image>）。 */
        var previewState = React.useState({});
        var previews = previewState[0];
        var setPreviews = previewState[1];

        /** 节点信息位：nodeId → 「provider · model · 耗时 · 花费」一行（来自 host 的 detail）。 */
        var detailState = React.useState({});
        var details = detailState[0];
        var setDetails = detailState[1];

        /** 大图灯箱：存图片的本地绝对路径；null = 关闭。双击缩略图 / 点「🖼 看成品」都能开。 */
        var lightboxState = React.useState(null);
        var lightbox = lightboxState[0];
        var setLightbox = lightboxState[1];

        /** 对话模式：agent/skill 用 POST /report 推过来的步骤表；null = 不在该模式（画本地那张图）。 */
        var externalState = React.useState(null);
        var external = externalState[0];
        var setExternal = externalState[1];
        /** 当前外部运行的 runId（用来过滤 firehose 上的事件）。 */
        var externalRunRef = React.useRef(null);

        var logState = React.useState([]);
        var logLines = logState[0];
        var setLogLines = logState[1];

        var runState = React.useState(null);
        var run = runState[0];
        var setRun = runState[1];

        // 载入面板：null = 收起；数组 = 已拉取的存盘列表
        var loadListState = React.useState(null);
        var loadList = loadListState[0];
        var setLoadList = loadListState[1];

        // ⏸ 审批状态：null = 没在等；{ state, note, preview }
        var approvalState = React.useState(null);
        var approval = approvalState[0];
        var setApproval = approvalState[1];

        // 🕘 运行历史
        var historyState = React.useState(loadHistory);
        var historyList = historyState[0];
        var setHistoryList = historyState[1];
        var historyOpenState = React.useState(false);
        var historyOpen = historyOpenState[0];
        var setHistoryOpen = historyOpenState[1];

        // 📋 模板面板：null = 收起；true = 展开中
        var templateOpenState = React.useState(false);
        var templateOpen = templateOpenState[0];
        var setTemplateOpen = templateOpenState[1];

        // ✨ AI 生成面板：null = 收起；对象 = { spec, busy, error }
        var genState = React.useState(null);
        var gen = genState[0];
        var setGen = genState[1];

        // 运行结果（独立展示区）：null = 还没跑过
        var runResultState = React.useState(null);
        var runResult = runResultState[0];
        var setRunResult = runResultState[1];
        /** 上一次的运行结果（**「收起」不会清掉它** —— 攒着给「📊 运行结果」按钮再调出来看）。 */
        var lastResultState = React.useState(null);
        var lastResult = lastResultState[0];
        var setLastResult = lastResultState[1];

        // 面板矩形：null = 还没算（先用 CSS 兜底的右下角定位），算出后由内联样式接管
        var boxState = React.useState(null);
        var box = boxState[0];
        var setBox = boxState[1];
        var resizeRef = React.useRef(null);
        /** 面板本体的 ref（拖动时要读它的实际位置）。 */
        var panelRef = React.useRef(null);
        /** 拖动状态：{ x, y, box }。 */
        var dragRef = React.useRef(null);
        /** 日志区高度（px）——由「画布 ↔ 日志」之间的分隔条拖动决定，默认 120。 */
        var logHeightState = React.useState(120);
        var logHeight = logHeightState[0];
        var setLogHeight = logHeightState[1];
        var logSplitRef = React.useRef(null);
        /** 窄屏（手机）：画布改成"底部抽屉"铺满宽度，不再往右挤 */
        var narrowState = React.useState(typeof window !== 'undefined' ? window.innerWidth <= 700 : false);
        var narrow = narrowState[0];
        var setNarrow = narrowState[1];
        React.useEffect(function () {
          function onResize() {
            setNarrow(window.innerWidth <= 700);
          }
          window.addEventListener('resize', onResize);
          return function () {
            window.removeEventListener('resize', onResize);
          };
        }, []);

        // 画布容器的**实测**尺寸 —— SVG 要跟着面板一起长大，
        // 否则拉大面板只是多留白，等于白拉。
        var stageRef = React.useRef(null);
        var stageSizeState = React.useState({ w: 900, h: 460 });
        var stageSize = stageSizeState[0];
        var setStageSize = stageSizeState[1];

        // 拖拽/连线用 ref —— 高频更新不该触发重渲染风暴
        var dragRef = React.useRef(null);
        var linkRef = React.useRef(null);
        var linkLineState = React.useState(null);
        var linkLine = linkLineState[0];
        var setLinkLine = linkLineState[1];
        var esRef = React.useRef(null);

        function pushLog(line) {
          setLogLines(function (prev) {
            var next = prev.concat([line]);
            return next.length > 120 ? next.slice(next.length - 120) : next;
          });
        }

        function patchNode(id, patch) {
          setGraph(function (prev) {
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
            out.nodes = prev.nodes.map(function (n) {
              if (n.id !== id) return n;
              var merged = {};
              for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) merged[k] = n[k];
              for (var k2 in patch) if (Object.prototype.hasOwnProperty.call(patch, k2)) merged[k2] = patch[k2];
              return merged;
            });
            return out;
          });
        }

        /** 最近一次出图/改图的产物路径（看成品用）。 */
        function latestPreviewPath() {
          var keys = Object.keys(previews);
          return keys.length > 0 ? previews[keys[keys.length - 1]] : null;
        }

        /** 「🖼 看成品」：把最近一张产物用灯箱放大看。 */
        function openLatestPreview() {
          var p = latestPreviewPath();
          if (!p) {
            pushLog('[看成品] 这次还没有产物图 —— 先跑一次模板（或看会话里的产物路径）');
            return;
          }
          setLightbox(p);
        }

        /** 「📋 复制图片」：把产物转成 PNG 塞进剪贴板（可以直接粘到别的软件）；失败就退回复制路径。 */
        function copyImage(path) {
          function fallback(error) {
            pushLog('[复制] 图片复制失败（' + String((error && error.message) || error) + '）→ 改为复制路径');
            copyPath(path);
          }
          fetch(ROUTE + '/asset?path=' + encodeURIComponent(path))
            .then(function (resp) {
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              return resp.blob();
            })
            .then(function (blob) {
              if (blob.type === 'image/png') return blob;
              // 非 PNG 先转一道（ClipboardItem 对类型挑剔）
              return createImageBitmap(blob).then(function (bmp) {
                var canvas = document.createElement('canvas');
                canvas.width = bmp.width;
                canvas.height = bmp.height;
                canvas.getContext('2d').drawImage(bmp, 0, 0);
                return new Promise(function (resolve) {
                  canvas.toBlob(function (b) {
                    resolve(b);
                  }, 'image/png');
                });
              });
            })
            .then(function (png) {
              if (!png) throw new Error('转 PNG 失败');
              return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
            })
            .then(function () {
              pushLog('[复制] 图片已进剪贴板 —— 可以直接粘贴到聊天/文档里');
            })
            .catch(fallback);
        }

        /** 「📋 复制路径」：把文件绝对路径放进剪贴板。 */
        function copyPath(path) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(path).then(
              function () {
                pushLog('[复制] 路径已进剪贴板：' + path);
              },
              function () {
                pushLog('[复制] 剪贴板不可用，路径是：' + path);
              },
            );
          } else {
            pushLog('[复制] 剪贴板不可用，路径是：' + path);
          }
        }

        /** 「📂 打开位置」：让 host 在资源管理器里选中这个文件（浏览器做不到）。 */
        function revealFile(path) {
          fetch(ROUTE + '/reveal', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path }),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j || j.ok !== true) {
                pushLog('[打开位置] 失败：' + JSON.stringify(j));
                return;
              }
              pushLog('[打开位置] 已在资源管理器里选中：' + j.path);
            })
            .catch(function (error) {
              pushLog('[打开位置] 出错：' + String((error && error.message) || error));
            });
        }

        /** 产物操作按钮组（结果面板与灯箱共用）。 */
        function previewActions(path) {
          function stop(event) {
            event.stopPropagation();
          }
          return React.createElement(
            'div',
            { key: 'preview-actions', style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
            React.createElement('button', { type: 'button', onClick: function (e) { stop(e); setLightbox(path); } }, '🖼 看大图'),
            React.createElement('button', { type: 'button', title: '复制图片本身（可粘贴到聊天/文档）', onClick: function (e) { stop(e); copyImage(path); } }, '📋 复制图片'),
            React.createElement('button', { type: 'button', title: '复制文件路径', onClick: function (e) { stop(e); copyPath(path); } }, '📋 复制路径'),
            React.createElement('button', { type: 'button', title: '在资源管理器里选中它', onClick: function (e) { stop(e); revealFile(path); } }, '📂 打开位置'),
          );
        }

        /** 「📊 运行结果」：把上一次的结果面板再调出来（点过「收起」也能看）。 */
        function showLastResult() {
          if (!lastResult) {
            pushLog('[运行结果] 还没跑过 —— 点 ▶ 运行，或先套一个模板');
            return;
          }
          setRunResult(lastResult);
        }

        /** 「🧹 清理」：手动清一次画布产物（走 host 的 /cleanup，只动画布自己的目录）。 */
        function runCleanup() {
          pushLog('[清理] 正在清理画布产物…');
          fetch(ROUTE + '/cleanup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (j) {
              if (!j || j.ok !== true) {
                pushLog('[清理] 失败：' + JSON.stringify(j));
                return;
              }
              var mb = (j.images.bytes / 1048576).toFixed(1);
              pushLog(
                '[清理] 完成：产物图删了 ' + j.images.deleted + ' 个 / ' + mb + 'MB；临时文件 ' + j.tmp.deleted +
                  ' 个（只删 ' + j.ttlDays + ' 天前的、且只用画布自己的目录）',
              );
              if (j.images.errors && j.images.errors.length > 0) pushLog('[清理] 有 ' + j.images.errors.length + ' 个删不掉：' + j.images.errors[0]);
            })
            .catch(function (error) {
              pushLog('[清理] 出错：' + String((error && error.message) || error));
            });
        }

        /**
         * 节点级事件：按 nodeId **精确上色** + 存缩略图。
         * 本地运行与「对话模式」共用这一套（label 兜底只在本地运行那条流里有）。
         * @returns {boolean} 是否已按 id 处理（false = 交给调用方走 label 兜底）
         */
        function applyNodeEvent(d) {
          if (!d) return false;
          var st = d.state || 'running';
          if (d.detail && d.nodeId) {
            var detailText = String(d.detail);
            var detailId = d.nodeId;
            setDetails(function (prev) {
              var out = {};
              for (var dk in prev) if (Object.prototype.hasOwnProperty.call(prev, dk)) out[dk] = prev[dk];
              out[detailId] = detailText;
              return out;
            });
          }
          if (d.preview && d.preview.path && d.nodeId) {
            var previewPath = d.preview.path;
            var previewId = d.nodeId;
            setPreviews(function (prev) {
              var out = {};
              for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
              out[previewId] = previewPath;
              return out;
            });
          }
          if (!d.nodeId) return false;
          setStatus(function (prev) {
            var out = {};
            for (var key2 in prev) if (Object.prototype.hasOwnProperty.call(prev, key2)) out[key2] = prev[key2];
            out[d.nodeId] = st;
            return out;
          });
          return true;
        }

        // ── 对话模式：常驻监听「外部运行」的事件（由 POST /report 推过来）──
        // 为什么要单开一条流：本地运行的流是按 runId 订阅的，而外部运行的 runId 我们事先不知道；
        // 用 runId 为空的 firehose，就能捡到所有事件，再按 externalRunRef 过滤。
        React.useEffect(function () {
          var es = null;
          try {
            es = new EventSource(ROUTE + '/events');
          } catch (error) {
            return function () {};
          }
          function pick(name, handler) {
            es.addEventListener(name, function (event) {
              var d = null;
              try {
                d = JSON.parse(event.data);
              } catch (error) {
                return;
              }
              if (!d || !d.runId) return;
              if (name === 'canvas/external') {
                handler(d);
                return;
              }
              if (externalRunRef.current === null || d.runId !== externalRunRef.current) return;
              handler(d);
            });
          }
          pick('canvas/external', function (d) {
            if (!Array.isArray(d.nodes)) return;
            if (d.runId) externalRunRef.current = d.runId;
            setExternal({ title: d.title || '对话模式运行', nodes: d.nodes });
            setStatus({});
            pushLog('[对话模式] 画布接管 ' + d.nodes.length + ' 个步骤：' + (d.title || ''));
          });
          pick('canvas/node', function (d) {
            applyNodeEvent(d);
          });
          pick('canvas/result', function (d) {
            var snapshot = {
              stopReason: d.stopReason,
              value: d.value,
              error: d.error || null,
              agentsStarted: d.agentsStarted,
              at: Date.now(),
              order: [],
            };
            setLastResult(snapshot);
            setRunResult(snapshot);
            pushLog('[对话模式][结果] stopReason=' + d.stopReason + (d.error ? ' · ' + d.error : ''));
          });
          return function () {
            try {
              es.close();
            } catch (error) {
              /* ignore */
            }
          };
        }, []);

        /** 只合并节点的 data（label / prompt），其余字段原样保留。 */
        function patchNodeData(id, dataPatch) {
          setGraph(function (prev) {
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
            out.nodes = prev.nodes.map(function (n) {
              if (n.id !== id) return n;
              var merged = {};
              for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) merged[k] = n[k];
              var data = {};
              var src = n.data || {};
              for (var dk in src) if (Object.prototype.hasOwnProperty.call(src, dk)) data[dk] = src[dk];
              for (var dk2 in dataPatch) if (Object.prototype.hasOwnProperty.call(dataPatch, dk2)) data[dk2] = dataPatch[dk2];
              merged.data = data;
              return merged;
            });
            return out;
          });
        }

        function addNode(type) {
          setGraph(function (prev) {
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
            var id = nextNodeId(prev);
            var data =
              type === 'trigger'
                ? { prompt: '请输入起始提示词' }
                : type === 'agent'
                  ? { prompt: '请描述这个子代理要做什么', label: id }
                  : type === 'code'
                    ? { code: 'return inputs;' }
                    : type === 'condition'
                      ? { expr: 'true', label: id }
                      : type === 'approval'
                        ? { note: '这一段的产出要不要继续？' }
                        : {};
            out.nodes = prev.nodes.concat([{ id: id, type: type, position: freeSpot(prev), data: data }]);
            return out;
          });
        }

        /** 删掉一条连线。 */
        function deleteEdge(edgeId) {
          setGraph(function (prev) {
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
            out.edges = prev.edges.filter(function (e) {
              return e.id !== edgeId;
            });
            return out;
          });
          setSelectedEdge(null);
        }

        /** 删除当前选中项（连线优先，其次节点；删节点会连带它的边）。 */
        function removeSelection() {
          if (selectedEdge) {
            deleteEdge(selectedEdge);
            return;
          }
          if (!selected) return;
          var gone = selected;
          setGraph(function (prev) {
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
            out.nodes = prev.nodes.filter(function (n) {
              return n.id !== gone;
            });
            out.edges = prev.edges.filter(function (e) {
              return e.from !== gone && e.to !== gone;
            });
            return out;
          });
          setSelected(null);
        }

        function connect(from, to) {
          if (from === to) return;
          setGraph(function (prev) {
            var exists = prev.edges.some(function (e) {
              return e.from === from && e.to === to;
            });
            if (exists) return prev;
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];

            var edge = { id: 'e' + from + '_' + to + '_' + prev.edges.length, from: from, to: to };
            // 判断节点的出边自动分「是 / 否」：第 1 条是，第 2 条起是「否」。
            // 这样拖完就是对的，不用再去点连线切换。
            var fromNode = null;
            for (var i = 0; i < prev.nodes.length; i++) {
              if (prev.nodes[i].id === from) fromNode = prev.nodes[i];
            }
            if (fromNode && fromNode.type === 'condition') {
              var outCount = 0;
              for (var j = 0; j < prev.edges.length; j++) {
                if (prev.edges[j].from === from) outCount += 1;
              }
              if (outCount >= 1) edge.branch = 'else';
            }
            out.edges = prev.edges.concat([edge]);
            return out;
          });
        }

        /** 改一条边的字段（条件 expr 等）。 */
        function patchEdge(edgeId, patch) {
          setGraph(function (prev) {
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
            out.edges = prev.edges.map(function (e) {
              if (e.id !== edgeId) return e;
              var merged = {};
              for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) merged[k] = e[k];
              for (var k2 in patch) if (Object.prototype.hasOwnProperty.call(patch, k2)) merged[k2] = patch[k2];
              return merged;
            });
            return out;
          });
        }

        /** 在**同一个源节点**的出边之间上移/下移（顺序 = 试试的先后）。 */
        function moveEdge(edgeId, delta) {
          setGraph(function (prev) {
            var idx = -1;
            for (var i = 0; i < prev.edges.length; i++) {
              if (prev.edges[i].id === edgeId) {
                idx = i;
                break;
              }
            }
            if (idx < 0) return prev;
            var from = prev.edges[idx].from;
            var siblings = [];
            for (var j = 0; j < prev.edges.length; j++) {
              if (prev.edges[j].from === from) siblings.push(j);
            }
            var pos = siblings.indexOf(idx);
            var target = pos + delta;
            if (target < 0 || target >= siblings.length) return prev;
            var arr = prev.edges.slice();
            var other = siblings[target];
            var tmp = arr[idx];
            arr[idx] = arr[other];
            arr[other] = tmp;
            var out = {};
            for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
            out.edges = arr;
            return out;
          });
        }

        function nodeAt(id) {
          for (var i = 0; i < graph.nodes.length; i++) {
            if (graph.nodes[i].id === id) return graph.nodes[i];
          }
          return null;
        }

        // ── 拖拽 / 连线（pointer 事件）──

        function clientToStage(event) {
          var svg = document.querySelector('[data-canvas-svg="1"]');
          if (!svg) return { x: 0, y: 0 };
          var rect = svg.getBoundingClientRect();
          return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }

        function onNodeDown(id, event) {
          event.stopPropagation();
          setSelected(id);
          setSelectedEdge(null);
          var node = nodeAt(id);
          if (!node) return;
          var p = clientToStage(event);
          dragRef.current = { id: id, dx: p.x - node.position.x, dy: p.y - node.position.y };
          linkRef.current = null;
        }

        function onPortDown(id, event) {
          event.stopPropagation();
          var p = clientToStage(event);
          linkRef.current = { from: id };
          dragRef.current = null;
          setLinkLine({ from: id, x: p.x, y: p.y });
        }

        function onNodeUp(id) {
          if (linkRef.current && linkRef.current.from !== id) {
            connect(linkRef.current.from, id);
          }
        }

        function onStageMove(event) {
          var p = clientToStage(event);
          if (dragRef.current) {
            var d = dragRef.current;
            patchNode(d.id, {
              position: { x: Math.max(0, Math.round(p.x - d.dx)), y: Math.max(0, Math.round(p.y - d.dy)) },
            });
            return;
          }
          if (linkRef.current) setLinkLine({ from: linkRef.current.from, x: p.x, y: p.y });
        }

        function onStageUp() {
          dragRef.current = null;
          linkRef.current = null;
          setLinkLine(null);
        }

        // ── 运行 / SSE ──

        function closeStream() {
          try {
            if (esRef.current) esRef.current.close();
          } catch (error) {
            /* 忽略 */
          }
          esRef.current = null;
        }

        function openStream(runId, order) {
          closeStream();
          var nodeById = {};
          for (var i = 0; i < graph.nodes.length; i++) nodeById[graph.nodes[i].id] = graph.nodes[i];

          // agent 节点（按图顺序）→ 用 label 把事件映射回节点
          var agentNodes = [];
          for (var j = 0; j < order.length; j++) {
            var node = nodeById[order[j]];
            if (node && node.type === 'agent') {
              agentNodes.push({ id: node.id, label: (node.data && node.data.label) || node.id, done: false });
            }
          }

          var es;
          try {
            es = new EventSource(ROUTE + '/events?runId=' + encodeURIComponent(runId));
          } catch (error) {
            pushLog('[事件流] 打不开：' + String((error && error.message) || error));
            return;
          }
          esRef.current = es;

          function mark(label, st) {
            var hit = null;
            for (var k = 0; k < agentNodes.length; k++) {
              if (agentNodes[k].label === label && !agentNodes[k].done) hit = agentNodes[k];
            }
            if (!hit) {
              for (var k2 = 0; k2 < agentNodes.length; k2++) {
                if (!agentNodes[k2].done) {
                  hit = agentNodes[k2];
                  break;
                }
              }
            }
            if (!hit) return;
            if (st !== 'running') hit.done = true;
            setStatus(function (prev) {
              var out = {};
              for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key];
              out[hit.id] = st;
              return out;
            });
          }

          var parseFailures = 0;
          function on(name, fn) {
            es.addEventListener(name, function (event) {
              try {
                fn(JSON.parse(event.data));
              } catch (error) {
                // 单条事件解析失败不该影响其他，但也不该悄悄吞掉（高亮不亮时无从排查）
                parseFailures += 1;
                if (parseFailures <= 3) {
                  console.warn('[dsh-canvas] 事件解析失败：' + name + ' / ' + String((error && error.message) || error));
                }
              }
            });
          }

          on('workflow/phase', function (d) {
            pushLog('[阶段] ' + d.phase);
          });
          on('workflow/log', function (d) {
            pushLog('[日志] ' + d.message);
          });
          on('workflow/agent-start', function (d) {
            pushLog('[子代理 #' + d.seq + ' 开工] ' + d.label);
            // host 已经给了 nodeId → 上色交给 canvas/node（精确）。没有才退回按 label 猜。
            if (d && d.nodeId) return;
            mark(d.label, 'running');
          });
          on('workflow/agent-end', function (d) {
            pushLog('[子代理 #' + d.seq + ' 结束] ' + d.label + ' → ' + d.outcome);
            if (d && d.nodeId) return; // 同上：上色由 canvas/node 负责
            mark(d.label, d.outcome === 'completed' ? 'done' : d.outcome === 'cancelled' ? 'cancelled' : 'failed');
          });
          // 节点级状态（host 侧已把 label 还原成稳定 id）→ **按 id 直接上色**，不再猜 label。
          // 覆盖所有节点类型（trigger / image / condition / parallel / approval / output），
          // 因为编译出来的脚本对每个节点都会 phase() 一次。
          on('canvas/node', function (d) {
            if (!d) return;
            var st = d.state || 'running';
            // 按 id 精确上色 + 存缩略图（与「对话模式」共用同一套）
            if (applyNodeEvent(d)) {
              if (st !== 'running') {
                for (var i = 0; i < agentNodes.length; i++) {
                  if (agentNodes[i].id === d.nodeId) agentNodes[i].done = true;
                }
              }
              return;
            }
            // 老事件没有 nodeId 时退回 label 匹配（向后兼容）
            if (d.label) mark(d.label, st);
          });
          on('canvas/phase', function (d) {
            if (d && d.text) pushLog('[阶段] ' + d.text);
          });
          on('canvas/approval', function (d) {
            if (!d) return;
            if (d.state === 'waiting') {
              pushLog('[⏸ 等待审批] ' + (d.note || '') + (d.preview ? ' —— ' + d.preview.slice(0, 100) : ''));
            } else if (d.state === 'approved') {
              pushLog('[✅ 审批通过] ' + ((d.selected || []).join('、') || '通过'));
            } else if (d.state === 'rejected') {
              pushLog('[❌ 审批被拒] ' + ((d.selected || []).join('、') || '拒绝'));
            }
            setApproval({ state: d.state, note: d.note || '', preview: d.preview || '' });
          });
          on('canvas/queued', function (d) {
            pushLog(
              '[已排队] ' + (d.nodeIds || []).join(' → ') + ' · 经由 ' + (d.via || 'engine') +
                (d.polling ? ' · 逐节点轮询已开' : ''),
            );
            // 有轮询时交给 canvas/nodes 精确点亮；没有才退化成"整体全亮"。
            if (d.polling) return;
            setStatus(function (prev) {
              var out = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) out[k] = prev[k];
              for (var q = 0; q < agentNodes.length; q++) out[agentNodes[q].id] = 'running';
              return out;
            });
          });
          // host 侧轮询 subagents 得到的逐节点进度（全量快照）
          on('canvas/nodes', function (d) {
            var list = d.nodes || [];
            if (d.note) pushLog('[进度] ' + d.note);
            // ⚠️ 实测两个坑（2026-09-23）：
            //   1. one-shot 子代理的 `label` 是**空串**（provider 没登记，类型里本就是 `label?`）
            //      → 只能**按出现顺序**映射到 agent 节点；
            //   2. listChildren 会带出**历史**子代理（同一父会话以前跑的）→ 它按 createdAt 排序，
            //      所以只取**最后 N 个**（N = 本图 agent 节点数），本次新建的必然在末尾。
            var tail = list.length > agentNodes.length ? list.slice(list.length - agentNodes.length) : list;
            setStatus(function (prev) {
              var out = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) out[k] = prev[k];
              for (var q = 0; q < tail.length; q++) {
                var item = tail[q];
                var hit = null;
                if (item.label) {
                  for (var r = 0; r < agentNodes.length; r++) {
                    if (agentNodes[r].label === item.label) {
                      hit = agentNodes[r];
                      break;
                    }
                  }
                }
                if (!hit) hit = agentNodes[q] || null;
                if (!hit) continue;
                if (item.status === 'running') {
                  hit.done = false;
                  out[hit.id] = 'running';
                } else {
                  hit.done = true;
                  out[hit.id] = 'done';
                }
              }
              return out;
            });
          });
          on('canvas/result', function (d) {
            pushLog('[结果] stopReason=' + d.stopReason + (d.agentsStarted >= 0 ? ' · 子代理 ' + d.agentsStarted + ' 个' : ''));
            if (d.error) pushLog('[错误] ' + d.error);
            if (d.value !== null && d.value !== undefined) pushLog('[返回值] ' + JSON.stringify(d.value));
            var finalStatus = d.stopReason === 'completed' ? 'done' : d.stopReason === 'cancelled' ? 'cancelled' : 'failed';
            // 记一条运行历史（结果摘要截断，免得 localStorage 被长文本撑爆）
            try {
              var summary = String(d.error || extractMainResult(d.value) || '').slice(0, 300);
              var entry = {
                at: Date.now(),
                name: graph.name || '（未命名）',
                stopReason: d.stopReason,
                agentsStarted: d.agentsStarted,
                summary: summary,
                nodes: graph.nodes.length,
                order: agentNodes.map(function (n) {
                  return n.id;
                }),
              };
              setHistoryList(function (prev) {
                var next = [entry].concat(prev || []).slice(0, HISTORY_MAX);
                saveHistory(next);
                return next;
              });
            } catch (error) {
              /* 记历史失败不该影响运行 */
            }

            var resultSnapshot = {
              stopReason: d.stopReason,
              value: d.value,
              error: d.error || null,
              agentsStarted: d.agentsStarted,
              at: Date.now(),
              order: agentNodes.map(function (n) {
                return n.id;
              }),
            };
            setLastResult(resultSnapshot); // 攒着：收起后还能用按钮调回来
            setRunResult(resultSnapshot);
            setStatus(function (prev) {
              var out = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) out[k] = prev[k];
              for (var q = 0; q < agentNodes.length; q++) out[agentNodes[q].id] = finalStatus;
              return out;
            });
            setRun(function (prev) {
              return prev ? { runId: prev.runId, running: false, order: prev.order } : prev;
            });
          });

          es.onerror = function () {
            pushLog('[事件流] 连接中断（结果可能已经出来了）');
          };
        }

        function startRun() {
          setStatus({});
          setLogLines([]);
          setRunResult(null);
          setApproval(null);
          pushLog('正在提交画布…');
          fetch(ROUTE + '/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ graph: graph, maxTotalAgents: 8 }),
          })
            .then(function (r) {
              return r.json().then(function (data) {
                return { status: r.status, data: data };
              });
            })
            .then(function (out) {
              if (!out.data || out.data.ok !== true) {
                pushLog('[提交失败] ' + String((out.data && out.data.error) || 'HTTP ' + out.status));
                return;
              }
              pushLog('[已启动] runId=' + out.data.runId + ' · 父会话=' + out.data.sessionId);
              if (out.data.warnings && out.data.warnings.length) pushLog('[警告] ' + out.data.warnings.join('；'));
              setRun({ runId: out.data.runId, running: true, order: out.data.order || [] });
              openStream(out.data.runId, out.data.order || []);
            })
            .catch(function (error) {
              pushLog('[提交异常] ' + String((error && error.message) || error));
            });
        }

        function stopRun() {
          if (!run) return;
          fetch(ROUTE + '/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId: run.runId }),
          })
            .then(function () {
              pushLog('[已请求停止]');
              setRun({ runId: run.runId, running: false, order: run.order });
            })
            .catch(function (error) {
              pushLog('[停止失败] ' + String((error && error.message) || error));
            });
        }

        function saveGraph() {
          fetch(ROUTE + '/graph', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: graph.name, graph: graph }),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (d) {
              pushLog(d && d.ok ? '[已存盘] ' + d.file : '[存盘失败] ' + String((d && d.error) || ''));
            })
            .catch(function (error) {
              pushLog('[存盘异常] ' + String((error && error.message) || error));
            });
        }

        /** 拉取/收起「已存盘画布」列表。 */
        function openLoadList() {
          if (loadList) {
            setLoadList(null);
            return;
          }
          pushLog('[载入] 正在读取存盘列表…');
          fetch(ROUTE + '/graphs')
            .then(function (r) {
              return r.json();
            })
            .then(function (d) {
              if (!d || d.ok !== true) {
                pushLog('[载入失败] ' + String((d && d.error) || ''));
                return;
              }
              pushLog('[载入] 共 ' + d.count + ' 个已存盘画布');
              setLoadList(d.items || []);
            })
            .catch(function (error) {
              pushLog('[载入异常] ' + String((error && error.message) || error));
            });
        }

        /** 按名字载入一张画布。 */
        function loadGraphByName(name) {
          fetch(ROUTE + '/graph?name=' + encodeURIComponent(name))
            .then(function (r) {
              return r.json();
            })
            .then(function (d) {
              if (!d || d.ok !== true || !d.graph) {
                pushLog('[载入失败] ' + String((d && d.error) || ''));
                return;
              }
              setGraph(d.graph);
              setStatus({});
              setSelected(null);
              setSelectedEdge(null);
              setLoadList(null);
              closeStream();
              pushLog('[已载入] ' + name + '（' + ((d.graph.nodes || []).length) + ' 个节点）');
            })
            .catch(function (error) {
              pushLog('[载入异常] ' + String((error && error.message) || error));
            });
        }

        /** 删掉一张存盘画布（带二次确认）。 */
        function deleteGraphByName(name) {
          if (typeof window.confirm === 'function' && !window.confirm('确定删掉画布「' + name + '」吗？删了就回不来了。')) {
            return;
          }
          fetch(ROUTE + '/graph/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name }),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (d) {
              if (!d || d.ok !== true) {
                pushLog('[删除失败] ' + String((d && d.error) || ''));
                return;
              }
              pushLog('[已删除] ' + name);
              setLoadList(function (prev) {
                return (prev || []).filter(function (x) {
                  return x.name !== name;
                });
              });
            })
            .catch(function (error) {
              pushLog('[删除异常] ' + String((error && error.message) || error));
            });
        }

        /** 首次打开时按窗口算一个"右下角"的初始矩形。 */
        React.useEffect(
          function () {
            if (!open || box) return;
            var w = Math.min(960, Math.max(360, window.innerWidth - 40));
            var h = Math.min(780, Math.max(280, Math.round(window.innerHeight * 0.82)));
            setBox({
              left: Math.max(8, window.innerWidth - w - 18),
              top: Math.max(8, window.innerHeight - h - 66),
              width: w,
              height: h,
            });
          },
          [open, box],
        );

        /** 浏览器窗口变小/变大时，把面板夹回可视范围（防止被甩出屏幕）。 */
        React.useEffect(
          function () {
            if (!open) return undefined;
            var onWin = function () {
              setBox(function (prev) {
                if (!prev) return prev;
                return {
                  left: Math.min(Math.max(0, prev.left), Math.max(0, window.innerWidth - 160)),
                  top: Math.min(Math.max(0, prev.top), Math.max(0, window.innerHeight - 100)),
                  width: Math.min(prev.width, Math.max(320, window.innerWidth - 16)),
                  height: Math.min(prev.height, Math.max(240, window.innerHeight - 16)),
                };
              });
            };
            window.addEventListener('resize', onWin);
            return function () {
              window.removeEventListener('resize', onWin);
            };
          },
          [open],
        );

        /** 盯住画布容器的真实尺寸（面板拉伸 / 窗口缩放 / 侧栏开合都会触发）。 */
        React.useEffect(
          function () {
            if (!open) return undefined;
            var el = stageRef.current;
            if (!el || typeof ResizeObserver !== 'function') return undefined;
            var ro = new ResizeObserver(function (entries) {
              for (var i = 0; i < entries.length; i++) {
                var rect = entries[i].contentRect;
                var w = Math.max(200, Math.round(rect.width));
                var h = Math.max(140, Math.round(rect.height));
                setStageSize(function (prev) {
                  return prev.w === w && prev.h === h ? prev : { w: w, h: h };
                });
              }
            });
            ro.observe(el);
            return function () {
              ro.disconnect();
            };
          },
          [open],
        );

        /** 开始拖边界：按 dir 里的 n/s/e/w 组合改 left/top/width/height。 */
        /**
         * 拖动面板：按住**标题条**移动。
         * 面板默认是 right/bottom 定位（没有显式坐标）→ 拖动开始那一刻先把当前位置量出来
         * 变成显式的 left/top，之后就跟手走了（顺带让「缩放手柄」也可用，它们要求先有 box）。
         */
        function startPanelDrag(event) {
          if (event.button !== 0 && event.button !== undefined) return;
          event.preventDefault();
          event.stopPropagation();
          var el = panelRef.current;
          if (!el) return;
          var rect = el.getBoundingClientRect();
          var origin = {
            x: event.clientX,
            y: event.clientY,
            box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          };
          dragRef.current = origin;
          setBox(origin.box);

          function onMove(e) {
            var st = dragRef.current;
            if (!st) return;
            var left = st.box.left + (e.clientX - st.x);
            var top = st.box.top + (e.clientY - st.y);
            left = Math.max(0, Math.min(left, window.innerWidth - 140));
            top = Math.max(0, Math.min(top, window.innerHeight - 44));
            setBox({ left: left, top: top, width: st.box.width, height: st.box.height });
          }
          function onUp() {
            dragRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          }
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        }

        /**
         * 拖动「画布 ↔ 日志」之间的分隔条：往上拖 = 日志变高。
         * 有了它，日志区就不再用百分比把自己撑到盖住画布。
         */
        function startLogSplit(event) {
          if (event.button !== 0 && event.button !== undefined) return;
          event.preventDefault();
          event.stopPropagation();
          var startY = event.clientY;
          var startH = logHeight;
          var panelEl = panelRef.current;
          var panelH = panelEl ? panelEl.getBoundingClientRect().height : 600;
          logSplitRef.current = { startY: startY, startH: startH };

          function onMove(e) {
            if (!logSplitRef.current) return;
            var next = startH - (e.clientY - startY);
            var max = Math.max(60, Math.min(panelH * 0.7, 640));
            setLogHeight(Math.max(40, Math.min(next, max)));
          }
          function onUp() {
            logSplitRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          }
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        }

        function startResize(dir, event) {
          if (!box) return;
          event.preventDefault();
          event.stopPropagation();
          resizeRef.current = {
            x: event.clientX,
            y: event.clientY,
            box: { left: box.left, top: box.top, width: box.width, height: box.height },
          };

          function onMove(e) {
            var r = resizeRef.current;
            if (!r) return;
            var dx = e.clientX - r.x;
            var dy = e.clientY - r.y;
            var b = r.box;
            var MIN_W = 360;
            var MIN_H = 240;
            var next = { left: b.left, top: b.top, width: b.width, height: b.height };
            if (dir.indexOf('e') >= 0) next.width = Math.max(MIN_W, b.width + dx);
            if (dir.indexOf('s') >= 0) next.height = Math.max(MIN_H, b.height + dy);
            if (dir.indexOf('w') >= 0) {
              var w2 = Math.max(MIN_W, b.width - dx);
              next.left = b.left + (b.width - w2);
              next.width = w2;
            }
            if (dir.indexOf('n') >= 0) {
              var h2 = Math.max(MIN_H, b.height - dy);
              next.top = b.top + (b.height - h2);
              next.height = h2;
            }
            next.left = Math.max(0, Math.min(next.left, window.innerWidth - 120));
            next.top = Math.max(0, Math.min(next.top, window.innerHeight - 80));
            setBox(next);
          }

          function onUp() {
            resizeRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          }
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        }

        /** 导出：把当前画布下载成 .json 文件。 */
        function exportGraph() {
          try {
            var text2 = JSON.stringify(graph, null, 2);
            var blob = new Blob([text2], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = (graph.name || 'canvas') + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () {
              URL.revokeObjectURL(url);
            }, 2000);
            pushLog('[已导出] ' + a.download + '（' + text2.length + ' 字节）');
          } catch (error) {
            pushLog('[导出失败] ' + String((error && error.message) || error));
          }
        }

        /** 导入：读一个 .json 文件铺到画布上。 */
        function importGraph() {
          try {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = function () {
              var file = input.files && input.files[0];
              if (!file) return;
              var reader = new FileReader();
              reader.onload = function () {
                try {
                  var obj = JSON.parse(String(reader.result));
                  // 容忍两种包装：裸画布 / { graph: 画布 }
                  var g = obj && obj.graph ? obj.graph : obj;
                  if (!g || !Array.isArray(g.nodes) || g.nodes.length === 0) {
                    pushLog('[导入失败] 这不像一张画布（缺 nodes）');
                    return;
                  }
                  // ⚠️ 归一化：分享来的画布可能省掉了 position（AI 生成的也会省），
                  // 渲染期裸读 position.x 会抛 TypeError → 整个 slot 崩、拖垮别的插件 UI。
                  var normalized = normalizeIncoming(g);
                  setGraph(normalized);
                  setStatus({});
                  setSelected(null);
                  setSelectedEdge(null);
                  setRunResult(null);
                  closeStream();
                  pushLog('[已导入] ' + file.name + '（' + normalized.nodes.length + ' 个节点 / ' + normalized.edges.length + ' 条连线）');
                } catch (error) {
                  pushLog('[导入失败] JSON 解析不了：' + String((error && error.message) || error));
                }
              };
              reader.readAsText(file);
            };
            input.click();
          } catch (error) {
            pushLog('[导入失败] ' + String((error && error.message) || error));
          }
        }

        /** 展开 / 收起 AI 生成面板。 */
        function toggleGenerate() {
          setGen(gen ? null : { spec: "", busy: false, error: null });
        }

        /** 让 AI 把一句话变成画布。 */
        function doGenerate() {
          if (!gen) return;
          var spec = String(gen.spec || "").trim();
          if (spec === "") return;
          setGen({ spec: spec, busy: true, error: null });
          pushLog("[AI] 正在生成画布…（要等一个子代理跑完，大约十几秒）");
          fetch(ROUTE + "/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spec: spec }),
          })
            .then(function (r) {
              return r.json().then(function (data) {
                return { status: r.status, data: data };
              });
            })
            .then(function (out) {
              if (!out.data || out.data.ok !== true) {
                var msg = String((out.data && out.data.error) || "HTTP " + out.status);
                setGen({ spec: spec, busy: false, error: msg });
                pushLog("[AI 失败] " + msg);
                return;
              }
              setGraph(out.data.graph);
              setStatus({});
              setSelected(null);
              setSelectedEdge(null);
              setGen(null);
              pushLog(
                "[AI 已生成] " + (out.data.graph.nodes || []).length + " 个节点 / " +
                  (out.data.graph.edges || []).length + " 条连线 —— 可以直接 ▶运行，不满意就改改",
              );
            })
            .catch(function (error) {
              var m2 = String((error && error.message) || error);
              setGen({ spec: spec, busy: false, error: m2 });
              pushLog("[AI 异常] " + m2);
            });
        }

        React.useEffect(function () {
          return function () {
            closeStream();
          };
        }, []);

        // ── 渲染 ──

        // 画布可视尺寸 = max(容器实测尺寸, 已有节点占用的尺寸)
        // —— 拉大面板能多看到画布；缩小时至少装得下内容（由容器滚动查看），绝不裁切节点。
        var needW = 0;
        var needH = 0;
        for (var needIdx = 0; needIdx < graph.nodes.length; needIdx++) {
          var needNode = graph.nodes[needIdx];
          // 防御性读：万一张图还是缺 position，也只是排版难看，不该把组件搞崩
          var needPos = needNode.position && typeof needNode.position === 'object' ? needNode.position : {};
          needW = Math.max(needW, (Number(needPos.x) || 0) + NODE_W + 40);
          needH = Math.max(needH, (Number(needPos.y) || 0) + NODE_H + 40);
        }
        var svgW = Math.max(400, stageSize.w, needW);
        var svgH = Math.max(300, stageSize.h, needH);

        var svgChildren = [];

        // 「对话模式」接管时：画的是 agent 推过来的**步骤表**（没有连线），否则画本地这张图。
        var viewNodes =
          external && Array.isArray(external.nodes) && external.nodes.length > 0 ? external.nodes : graph.nodes;
        var externalMode = viewNodes !== graph.nodes;

        for (var ei = 0; ei < (externalMode ? 0 : graph.edges.length); ei++) {
          var edge = graph.edges[ei];
          var fromNode = nodeAt(edge.from);
          var toNode = nodeAt(edge.to);
          if (!fromNode || !toNode) continue;
          var edgeD = edgePath(fromNode, toNode);
          var edgeSelected = selectedEdge === edge.id;

          // 判断节点的出边：标「第几路 + 这一路的条件」
          if (fromNode.type === 'condition') {
            var armIndex = 0;
            var armTotal = 0;
            for (var armScan = 0; armScan < graph.edges.length; armScan++) {
              if (graph.edges[armScan].from !== edge.from) continue;
              armTotal += 1;
              if (graph.edges[armScan].id === edge.id) armIndex = armTotal;
            }
            var ownExpr = typeof edge.expr === 'string' ? edge.expr.trim() : '';
            var isFallback = ownExpr === '' && edge.branch === 'else';
            var isLegacyThen = ownExpr === '' && edge.branch !== 'else';
            var text0 = ownExpr !== '' ? ownExpr : isFallback ? '兜底' : '是';
            if (text0.length > 14) text0 = text0.slice(0, 14) + '…';
            var chipText = armIndex + ' ' + text0;
            var chipW = Math.max(30, 15 + chipText.length * 7);
            // 同源的多条边共用起点，正中会叠在一起 → 按序号沿边均匀错开
            var tSpread =
              armTotal <= 1 ? 0.5 : 0.3 + ((armIndex - 1) / (armTotal - 1)) * 0.4;
            var mid = edgeMidpoint(fromNode, toNode, tSpread);
            var chipFill = isFallback ? '#f4f5f7' : isLegacyThen ? '#e8f6ec' : '#eef4ff';
            var chipStroke = isFallback ? '#8a8f9c' : isLegacyThen ? '#2f9e5f' : '#3f6ec4';
            svgChildren.push(
              React.createElement('rect', {
                key: 'edgetag-bg-' + edge.id,
                x: mid.x - chipW / 2,
                y: mid.y - 11,
                width: chipW,
                height: 22,
                rx: 11,
                fill: chipFill,
                stroke: chipStroke,
                strokeWidth: 1.3,
                style: { pointerEvents: 'none' },
              }),
            );
            svgChildren.push(
              React.createElement('text', {
                key: 'edgetag-' + edge.id,
                x: mid.x,
                y: mid.y + 4,
                fontSize: 11,
                fontWeight: 600,
                textAnchor: 'middle',
                fill: chipStroke,
                style: { pointerEvents: 'none' },
              },
                chipText,
              ),
            );
          }
          // 细线点不中 —— 先铺一条透明的粗线专门接鼠标事件
          svgChildren.push(
            React.createElement('path', {
              key: 'edgehit-' + edge.id,
              d: edgeD,
              fill: 'none',
              stroke: 'transparent',
              strokeWidth: 16,
              style: { cursor: 'pointer' },
              onClick: (function (id) {
                return function (event) {
                  event.stopPropagation();
                  setSelectedEdge(id);
                  setSelected(null);
                };
              })(edge.id),
              onDoubleClick: (function (id) {
                return function (event) {
                  event.stopPropagation();
                  deleteEdge(id);
                };
              })(edge.id),
            }),
          );
          svgChildren.push(
            React.createElement('path', {
              key: 'edge-' + edge.id,
              d: edgeD,
              fill: 'none',
              stroke: edgeSelected ? '#c0392b' : '#8fa0c2',
              strokeWidth: edgeSelected ? 3.2 : 2,
              strokeDasharray: edgeSelected ? '7 4' : undefined,
              style: { pointerEvents: 'none' },
            }),
          );
        }

        if (linkLine) {
          var src = nodeAt(linkLine.from);
          if (src) {
            svgChildren.push(
              React.createElement('path', {
                key: 'link-live',
                d:
                  'M ' + (src.position.x + NODE_W) + ' ' + (src.position.y + NODE_H / 2) +
                  ' L ' + linkLine.x + ' ' + linkLine.y,
                fill: 'none',
                stroke: '#3f6ec4',
                strokeWidth: 2,
                strokeDasharray: '6 4',
              }),
            );
          }
        }

        for (var ni = 0; ni < viewNodes.length; ni++) {
          svgChildren.push(
            React.createElement(NodeShape, {
              key: 'node-' + viewNodes[ni].id,
              node: viewNodes[ni],
              selected: selected === viewNodes[ni].id,
              status: status[viewNodes[ni].id] || null,
              preview: previews[viewNodes[ni].id] || null,
              detail: details[viewNodes[ni].id] || null,
              onOpenPreview: setLightbox,
              onNodeDown: onNodeDown,
              onNodeUp: onNodeUp,
              onPortDown: onPortDown,
            }),
          );
        }

        // 选中节点时出现的小属性条（P0 够用：改节点名 + 改提示词）
        var inspector = null;
        if (selected) {
          var selNode = nodeAt(selected);
          if (selNode) {
            var selStyle = TYPE_STYLE[selNode.type] || TYPE_STYLE.agent;
            var selData = selNode.data || {};
            // 按节点类型给不同的编辑字段
            var fields = [];
            if (selNode.type === 'agent' || selNode.type === 'condition') {
              fields.push(
                React.createElement('input', {
                  key: 'label',
                  type: 'text',
                  placeholder: '节点名',
                  value: selData.label || '',
                  onChange: function (event) {
                    patchNodeData(selNode.id, { label: event.target.value });
                  },
                }),
              );
            }
            if (selNode.type === 'agent') {
              fields.push(
                React.createElement(
                  'label',
                  { key: 'terse', className: 'tag', style: { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' } },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: selData.terse !== false,
                    onChange: function (event) {
                      patchNodeData(selNode.id, { terse: event.target.checked });
                    },
                  }),
                  '只输出结果（不加解释/自我评价）',
                ),
              );
              fields.push(
                React.createElement(
                  'label',
                  { key: 'retry', className: 'tag', style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                  '失败重试',
                  React.createElement('input', {
                    type: 'number',
                    min: 0,
                    max: 5,
                    style: { width: '52px' },
                    value: typeof selData.retry === 'number' ? selData.retry : 0,
                    onChange: function (event) {
                      var n2 = parseInt(event.target.value, 10);
                      patchNodeData(selNode.id, { retry: isNaN(n2) ? 0 : Math.max(0, Math.min(5, n2)) });
                    },
                  }),
                  '次（子代理返回 null 时重试）',
                ),
              );
            }
            if (selNode.type === 'trigger' || selNode.type === 'agent') {
              fields.push(
                React.createElement('textarea', {
                  key: 'prompt',
                  rows: 2,
                  placeholder: '提示词（可写 {{节点id}} 引用上游输出）',
                  value: selData.prompt || '',
                  onChange: function (event) {
                    patchNodeData(selNode.id, { prompt: event.target.value });
                  },
                }),
              );
            }
            if (selNode.type === 'code') {
              fields.push(
                React.createElement('textarea', {
                  key: 'code',
                  rows: 3,
                  placeholder: '内联 JS —— 上游在 inputs 里，用 return 交出本节点的值',
                  value: selData.code || '',
                  style: { fontFamily: 'ui-monospace,Consolas,monospace' },
                  onChange: function (event) {
                    patchNodeData(selNode.id, { code: event.target.value });
                  },
                }),
              );
            }
            if (selNode.type === 'condition') {
              // 条件现在写在**每条出边**上（老图则还在节点上）
              var upsOfSel = [];
              for (var eScan = 0; eScan < graph.edges.length; eScan++) {
                if (graph.edges[eScan].to === selNode.id) upsOfSel.push('inputs.' + graph.edges[eScan].from);
              }
              var armEdges = [];
              for (var eScan2 = 0; eScan2 < graph.edges.length; eScan2++) {
                if (graph.edges[eScan2].from === selNode.id) armEdges.push(graph.edges[eScan2]);
              }
              var anyExprOnEdge = armEdges.some(function (e) {
                return typeof e.expr === 'string' && e.expr.trim() !== '';
              });

              if (anyExprOnEdge) {
                fields.push(
                  React.createElement(
                    'span',
                    { key: 'armhint', className: 'tag' },
                    '这个判断有 ' + armEdges.length + ' 路 —— 条件写在每条出边上（点选连线去填）',
                  ),
                );
              } else {
                // 老图：条件还在节点上，保留输入框方便继续改
                fields.push(
                  React.createElement('textarea', {
                    key: 'expr',
                    rows: 2,
                    placeholder: 'JS 表达式，例如 inputs.n2 > 50（不能写中文句子）',
                    value: selData.expr || '',
                    style: { fontFamily: 'ui-monospace,Consolas,monospace' },
                    onChange: function (event) {
                      patchNodeData(selNode.id, { expr: event.target.value });
                    },
                  }),
                );
              }
              fields.push(
                React.createElement(
                  'span',
                  { key: 'varhint', className: 'tag' },
                  '可用：' + (upsOfSel.length > 0 ? upsOfSel.join('、') : '（还没连上游）'),
                ),
              );
              fields.push(
                React.createElement(
                  'span',
                  { key: 'orderhint', className: 'tag' },
                  '从上往下试；留空那条是无条件兜底、必须放最后',
                ),
              );
            }
            if (selNode.type === 'approval') {
              fields.push(
                React.createElement('textarea', {
                  key: 'note',
                  rows: 2,
                  placeholder: '跟人说什么？（审批卡片上的那句话）',
                  value: selData.note || '',
                  onChange: function (event) {
                    patchNodeData(selNode.id, { note: event.target.value });
                  },
                }),
              );
              fields.push(
                React.createElement(
                  'span',
                  { key: 'apprhint', className: 'tag' },
                  '跑到这里会停下，弹一张审批卡片等人点「通过 / 拒绝」；通过才继续跑后面',
                ),
              );
            }
            if (selNode.type === 'parallel') {
              var parArms = 0;
              for (var pa = 0; pa < graph.edges.length; pa++) {
                if (graph.edges[pa].from === selNode.id) parArms += 1;
              }
              fields.push(
                React.createElement(
                  'span',
                  { key: 'parhint', className: 'tag' },
                  '这个并行节点有 ' + parArms + ' 条分叉 —— 运行时同时执行，全部完成才继续',
                ),
              );
              fields.push(
                React.createElement(
                  'span',
                  { key: 'parhint2', className: 'tag' },
                  '分叉目前只能接「子代理」节点；汇合之后照常继续',
                ),
              );
            }
            if (selNode.type === 'output') {
              fields.push(React.createElement('span', { key: 'none', className: 'tag' }, '（输出节点没有可改的字段）'));
            }

            inspector = React.createElement(
              'div',
              { className: 'dsh-canvas-inspector' },
              React.createElement('span', { className: 'tag' }, selStyle.tag + ' ' + selNode.id),
              fields,
            );
          }
        }

        // 选中「连线」时的属性条：condition 的出边可以切 then / else
        var edgeInspector = null;
        if (selectedEdge) {
          var edgeObj = null;
          for (var eIdx = 0; eIdx < graph.edges.length; eIdx++) {
            if (graph.edges[eIdx].id === selectedEdge) {
              edgeObj = graph.edges[eIdx];
              break;
            }
          }
          if (edgeObj) {
            var fromOfEdge = nodeAt(edgeObj.from);
            var isCondEdge = Boolean(fromOfEdge && fromOfEdge.type === 'condition');
            var armNo = 0;
            var armTot = 0;
            for (var sc = 0; sc < graph.edges.length; sc++) {
              if (graph.edges[sc].from !== edgeObj.from) continue;
              armTot += 1;
              if (graph.edges[sc].id === edgeObj.id) armNo = armTot;
            }
            var edgeFields = [
              React.createElement('span', { key: 'who', className: 'tag' }, '连线 ' + edgeObj.from + ' → ' + edgeObj.to),
            ];
            if (isCondEdge) {
              edgeFields.push(
                React.createElement('span', { key: 'armno', className: 'tag' }, '第 ' + armNo + ' / ' + armTot + ' 路'),
              );
              edgeFields.push(
                React.createElement('textarea', {
                  key: 'expr',
                  rows: 1,
                  placeholder: '这一路的条件，例如 inputs.n2 > 66；留空 = 无条件兜底（要放最后）',
                  value: typeof edgeObj.expr === 'string' ? edgeObj.expr : '',
                  style: { fontFamily: 'ui-monospace,Consolas,monospace' },
                  onChange: (function (targetId) {
                    return function (event) {
                      patchEdge(targetId, { expr: event.target.value });
                    };
                  })(edgeObj.id),
                }),
              );
              edgeFields.push(
                React.createElement('button', {
                  key: 'up',
                  type: 'button',
                  onClick: (function (targetId) {
                    return function () {
                      moveEdge(targetId, -1);
                    };
                  })(edgeObj.id),
                }, '↑ 上移'),
              );
              edgeFields.push(
                React.createElement('button', {
                  key: 'down',
                  type: 'button',
                  onClick: (function (targetId) {
                    return function () {
                      moveEdge(targetId, 1);
                    };
                  })(edgeObj.id),
                }, '↓ 下移'),
              );
            } else {
              edgeFields.push(React.createElement('span', { key: 'plain', className: 'tag' }, '（普通连线：只能删除）'));
            }
            edgeInspector = React.createElement(
              'div',
              { className: 'dsh-canvas-inspector' },
              edgeFields,
            );
          }
        }

        var toolbar = React.createElement(
          'div',
          { className: 'dsh-canvas-head' },
          React.createElement('span', { className: 'dsh-canvas-title' }, '🎨 画布工作流'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('trigger'); } }, '＋起点'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('agent'); } }, '＋子代理'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('image'); } }, '＋图像'),
          React.createElement('button', { type: 'button', title: '放大看最近一张成图', onClick: function () { openLatestPreview(); } }, '🖼 看成品'),
          React.createElement('button', { type: 'button', title: '把上一次的运行结果再调出来（含成图预览）', onClick: function () { showLastResult(); } }, '📊 运行结果'),
          React.createElement('button', { type: 'button', title: '清掉画布自己的过期产物（不动主人的图库）', onClick: function () { runCleanup(); } }, '🧹 清理'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('code'); } }, '＋代码'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('condition'); } }, '＋判断'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('parallel'); } }, '＋并行'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('approval'); } }, '＋审批'),
          React.createElement('button', { type: 'button', onClick: function () { addNode('output'); } }, '＋输出'),
          React.createElement(
            'button',
            { type: 'button', onClick: removeSelection, disabled: !selected && !selectedEdge },
            selectedEdge ? '删除连线' : '删除选中',
          ),
          React.createElement(
            'button',
            { type: 'button', onClick: function () { setTemplateOpen(!templateOpen); } },
            templateOpen ? '📋 收起模板' : '📋 模板',
          ),
          React.createElement('button', { type: 'button', onClick: saveGraph }, '💾 存盘'),
          React.createElement('button', { type: 'button', onClick: exportGraph }, '📤 导出'),
          React.createElement(
            'button',
            { type: 'button', onClick: function () { setHistoryOpen(!historyOpen); } },
            (historyOpen ? '🕘 收起历史' : '🕘 历史') + (historyList.length > 0 ? ' ' + historyList.length : ''),
          ),
          React.createElement('button', { type: 'button', onClick: importGraph }, '📥 导入'),
          React.createElement(
            'button',
            { type: 'button', onClick: openLoadList },
            loadList ? '📂 收起列表' : '📂 载入',
          React.createElement(
            'button',
            { type: 'button', onClick: toggleGenerate },
            gen ? '✨ 收起生成' : '✨ AI 生成',
          ),
          ),
          React.createElement('span', { className: 'sp' }),
          React.createElement(
            'button',
            { type: 'button', className: 'primary', onClick: startRun, disabled: !!(run && run.running) },
            '▶ 运行',
          ),
          React.createElement('button', { type: 'button', onClick: stopRun, disabled: !run || !run.running }, '■ 停止'),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: function () {
                closeStream();
                setGraph(defaultGraph());
                setStatus({});
                setRun(null);
                setSelected(null);
                setLogLines([]);
              },
            },
            '重置',
          ),
          React.createElement(
            'button',
            { type: 'button', onClick: function () { setOpen(false); } },
            '收起',
          ),
        );

        var panelChildren = [
          // 标题条 = 拖动把手（面板默认 right/bottom 定位，按住这里可自由拖动）
          React.createElement(
            'div',
            {
              key: 'titlebar',
              className: 'dsh-canvas-titlebar',
              onPointerDown: startPanelDrag,
              title: '按住拖动面板',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 10px',
                cursor: 'move',
                userSelect: 'none',
                flex: '0 0 auto',
                borderBottom: '1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))',
              },
            },
            React.createElement('span', { style: { fontWeight: 600 } }, '🎨 画布工作流'),
            React.createElement('span', { style: { opacity: 0.55, fontSize: 12 } }, '⠿ 按住这里拖动面板'),
          ),
          React.createElement(
            'div',
            { key: 'stage', className: 'dsh-canvas-stagebox', ref: stageRef },
            React.createElement(
              'svg',
              {
                className: 'dsh-canvas-svg',
                'data-canvas-stage': '1',
                'data-canvas-svg': '1',
                width: svgW,
                height: svgH,
                viewBox: '0 0 ' + svgW + ' ' + svgH,
                onPointerDown: function () {
                  setSelected(null);
                  setSelectedEdge(null);
                },
                onPointerMove: onStageMove,
                onPointerUp: onStageUp,
                onPointerLeave: onStageUp,
              },
              svgChildren,
            ),
          ),
          loadList
            ? React.createElement(
                'div',
                { className: 'dsh-canvas-loadlist' },
                loadList.length === 0
                  ? React.createElement('div', { className: 'dim' }, '还没有存过画布 —— 先点 💾 存盘')
                  : loadList.map(function (item) {
                      return React.createElement(
                        'div',
                        {
                          key: item.name,
                          className: 'item',
                          onClick: function () {
                            loadGraphByName(item.name);
                          },
                        },
                        React.createElement('span', { className: 'grow' }, item.name),
                        React.createElement('span', { className: 'dim' }, Math.max(1, Math.round(item.bytes / 1024)) + ' KB'),
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            title: '删除这个画布',
                            onClick: function (event) {
                              event.stopPropagation();
                              deleteGraphByName(item.name);
                            },
                          },
                          '🗑',
                        ),
                      );
                    }),
              )
            : null,
          historyOpen
            ? React.createElement(
                'div',
                { className: 'dsh-canvas-loadlist' },
                React.createElement(
                  'div',
                  { className: 'item', style: { cursor: 'default' } },
                  React.createElement('span', { className: 'grow' }, '最近 ' + historyList.length + ' 次运行'),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      onClick: function () {
                        setHistoryList([]);
                        saveHistory([]);
                      },
                    },
                    '清空',
                  ),
                ),
                historyList.length === 0
                  ? React.createElement('div', { className: 'dim' }, '还没跑过 —— 点 ▶运行 试试')
                  : historyList.map(function (item, idx) {
                      var ok = item.stopReason === 'completed';
                      return React.createElement(
                        'div',
                        {
                          key: String(item.at) + '_' + idx,
                          className: 'item',
                          style: { cursor: 'default', alignItems: 'flex-start' },
                        },
                        React.createElement('span', { className: 'grow' },
                          (ok ? '✅ ' : '❌ ') + (item.summary || '（无结果）')),
                        React.createElement('span', { className: 'dim', style: { whiteSpace: 'nowrap' } },
                          shortTime(item.at) + ' · ' + (item.nodes || 0) + ' 节点'),
                      );
                    }),
              )
            : null,
          templateOpen
            ? React.createElement(
                'div',
                { className: 'dsh-canvas-loadlist' },
                TEMPLATES.map(function (tpl) {
                  return React.createElement(
                    'div',
                    {
                      key: tpl.id,
                      className: 'item',
                      onClick: function () {
                        setGraph(tpl.build());
                        setStatus({});
                        setSelected(null);
                        setSelectedEdge(null);
                        setRunResult(null);
                        setTemplateOpen(false);
                        closeStream();
                        pushLog('[已套用模板] ' + tpl.name + ' —— 直接点 ▶运行 就能跑');
                      },
                    },
                    React.createElement('span', { className: 'grow' }, tpl.name),
                    React.createElement('span', { className: 'dim' }, tpl.note),
                  );
                }),
              )
            : null,
          approval && approval.state === 'waiting'
            ? React.createElement(
                'div',
                {
                  className: 'dsh-canvas-result',
                  'data-state': 'waiting',
                  style: { borderColor: '#e0a52b66', background: '#fffaef' },
                },
                React.createElement(
                  'div',
                  { className: 'rs-head' },
                  React.createElement('span', null, '⏸ 等待审批中'),
                  React.createElement('span', { className: 'grow' }),
                  React.createElement('span', { className: 'dim' }, '请看会话里的审批卡片'),
                ),
                React.createElement(
                  'div',
                  { className: 'rs-body' },
                  approval.note,
                ),
                approval.preview
                  ? React.createElement('div', { className: 'rs-meta' }, '待审内容：' + approval.preview.slice(0, 200))
                  : null,
              )
            : null,
          runResult
            ? React.createElement(
                'div',
                {
                  className: 'dsh-canvas-result',
                  'data-state': runResult.stopReason === 'completed' ? 'completed' : 'error',
                },
                React.createElement(
                  'div',
                  { className: 'rs-head' },
                  React.createElement('span', null, runResult.stopReason === 'completed' ? '✅ 运行结果' : '❌ 运行失败'),
                  React.createElement('span', { className: 'grow' }),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      onClick: function () {
                        setRunResult(null);
                      },
                    },
                    '收起',
                  ),
                ),
                runResult.error
                  ? React.createElement('div', { className: 'rs-body' }, runResult.error)
                  : React.createElement('div', { className: 'rs-body' }, extractMainResult(runResult.value)),
                // 产物预览：把最近一次图像节点出的图直接贴出来（走 /asset 白名单路由）
                (function () {
                  var keys = Object.keys(previews);
                  if (keys.length === 0) return null;
                  var last = previews[keys[keys.length - 1]];
                  if (!last) return null;
                  return React.createElement(
                    'div',
                    { key: 'result-preview-box', style: { marginTop: 6 } },
                    React.createElement('img', {
                      key: 'img',
                      src: ROUTE + '/asset?path=' + encodeURIComponent(last),
                      alt: '产物预览',
                      title: '双击看大图',
                      onDoubleClick: function (event) {
                        event.stopPropagation();
                        setLightbox(last);
                      },
                      style: { maxWidth: '100%', maxHeight: 260, borderRadius: 10, cursor: 'zoom-in', display: 'block' },
                    }),
                    previewActions(last),
                  );
                })(),
                React.createElement(
                  'div',
                  { className: 'rs-meta' },
                  (runResult.order && runResult.order.length > 0 ? '走了 ' + runResult.order.join(' → ') : '') +
                    (runResult.agentsStarted >= 0 ? ' · ' + runResult.agentsStarted + ' 个子代理' : ''),
                ),
              )
            : null,
          gen
            ? React.createElement(
                'div',
                { className: 'dsh-canvas-inspector' },
                React.createElement('span', { className: 'tag' }, '✨ 想要什么流程？'),
                React.createElement('textarea', {
                  rows: 2,
                  placeholder: '用一句话描述，例如：抓取一个网页，总结成三句话，如果里面有「降价」就再发一条提醒',
                  value: gen.spec || "",
                  disabled: gen.busy,
                  onChange: function (event) {
                    setGen({ spec: event.target.value, busy: false, error: null });
                  },
                }),
                React.createElement(
                  'button',
                  { type: 'button', onClick: doGenerate, disabled: gen.busy },
                  gen.busy ? '生成中…' : '生成',
                ),
                gen.error ? React.createElement('span', { className: 'tag' }, '失败：' + gen.error) : null,
              )
            : null,
          // 对话模式横幅：告诉主人"画布正由对话里的本鲸接管"，并给一个出口
          external
            ? React.createElement(
                'div',
                {
                  key: 'external-banner',
                  className: 'dsh-canvas-hint',
                  style: {
                    background: 'rgba(43,108,255,.14)',
                    border: '1px solid rgba(43,108,255,.35)',
                    borderRadius: 8,
                    padding: '5px 9px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  },
                },
                React.createElement('span', null, '🔵 对话模式：' + (external.title || '运行中') + ' · 本鲸在对话里干活，这里实时同步'),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: function () {
                      externalRunRef.current = null;
                      setExternal(null);
                      setStatus({});
                    },
                  },
                  '退出对话模式',
                ),
              )
            : null,
          inspector,
          edgeInspector,
          React.createElement(
            'div',
            { key: 'hint', className: 'dsh-canvas-hint' },
            '拖节点移动 · 从右侧圆点拖出连线 · 点连线选中(变红)、双击直删',
            '判断节点：第 1 条出边自动=是、第 2 条=否；把「否」连到另一个判断，就是链式判断（if / else if / else）',
            '不会画就先点「📋 模板」套一个现成的，再改；或者点「✨ AI 生成」让它按你的话画',
          ),
          // 分隔条：上下拖动调日志区高度（不然日志会盖住画布）
          React.createElement('div', {
            key: 'logsplit',
            className: 'dsh-canvas-logsplit',
            title: '上下拖动：调整日志区高度',
            onPointerDown: startLogSplit,
          }),
          React.createElement(
            'div',
            { key: 'foot', className: 'dsh-canvas-foot', style: { height: logHeight + 'px' } },
            logLines.length === 0 ? '(运行日志会出现在这里)' : logLines.join('\n'),
          ),
          toolbar,
        ];

        return React.createElement(
          'div',
          { className: 'dsh-canvas-root' },
          open
            ? React.createElement(
                'div',
                {
                  className: 'dsh-canvas-panel',
                  ref: panelRef,
                  style: box
                    ? {
                        left: box.left + 'px',
                        top: box.top + 'px',
                        width: box.width + 'px',
                        height: box.height + 'px',
                      }
                    : narrow
                      ? {
                          // 手机：底部抽屉（铺满宽度、贴底），避免往右挤掉输入框
                          left: 0,
                          right: 0,
                          bottom: 0,
                          width: '100vw',
                          maxHeight: '74vh',
                          borderTopLeftRadius: '14px',
                          borderTopRightRadius: '14px',
                        }
                      : { right: '18px', bottom: '66px', width: 'min(960px,94vw)', maxHeight: 'min(82vh,780px)' },
                },
                panelChildren.concat([
                  React.createElement('div', { key: 'rs-n', className: 'dsh-canvas-rs dsh-canvas-rs-n', onPointerDown: function (e) { startResize('n', e); } }),
                  React.createElement('div', { key: 'rs-s', className: 'dsh-canvas-rs dsh-canvas-rs-s', onPointerDown: function (e) { startResize('s', e); } }),
                  React.createElement('div', { key: 'rs-w', className: 'dsh-canvas-rs dsh-canvas-rs-w', onPointerDown: function (e) { startResize('w', e); } }),
                  React.createElement('div', { key: 'rs-e', className: 'dsh-canvas-rs dsh-canvas-rs-e', onPointerDown: function (e) { startResize('e', e); } }),
                  React.createElement('div', { key: 'rs-nw', className: 'dsh-canvas-rs dsh-canvas-rs-nw', onPointerDown: function (e) { startResize('nw', e); } }),
                  React.createElement('div', { key: 'rs-ne', className: 'dsh-canvas-rs dsh-canvas-rs-ne', onPointerDown: function (e) { startResize('ne', e); } }),
                  React.createElement('div', { key: 'rs-sw', className: 'dsh-canvas-rs dsh-canvas-rs-sw', onPointerDown: function (e) { startResize('sw', e); } }),
                  React.createElement('div', { key: 'rs-se', className: 'dsh-canvas-rs dsh-canvas-rs-se', onPointerDown: function (e) { startResize('se', e); } }),
                ]),
              )
            : null,
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-canvas-fab',
              title: open ? '收起画布面板' : '打开画布工作流面板',
              onClick: function () {
                setOpen(!open);
              },
            },
            '🎨 画布',
          ),
          // 大图灯箱（固定浮层，点空白处关闭）
          lightbox
            ? React.createElement(
                'div',
                {
                  key: 'lightbox',
                  onClick: function () {
                    setLightbox(null);
                  },
                  style: {
                    position: 'fixed',
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 90,
                    background: 'rgba(8,12,20,.86)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'column',
                    gap: '10px',
                    cursor: 'zoom-out',
                  },
                },
                React.createElement('img', {
                  src: ROUTE + '/asset?path=' + encodeURIComponent(lightbox),
                  alt: '成图大图',
                  onClick: function (event) {
                    event.stopPropagation();
                  },
                  style: { maxWidth: '92vw', maxHeight: '80vh', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,.55)' },
                }),
                React.createElement(
                  'div',
                  {
                    onClick: function (event) {
                      event.stopPropagation();
                    },
                  },
                  previewActions(lightbox),
                ),
                React.createElement(
                  'div',
                  { style: { color: '#cfd8e8', fontSize: 12, maxWidth: '90vw', wordBreak: 'break-all', textAlign: 'center' } },
                  lightbox + '　·　点空白处关闭',
                ),
              )
            : null,
        );
      }

      /**
       * 挂载插件：注入样式 + 占用 shell.overlay 一格。
       * 全程降级保护 —— 插件异常绝不影响会话正常打字与发送。
       */
      function apply(ctx) {
        // 触屏打标（v3）：有些手机浏览器会把 hover/pointer 谎报成鼠标（"桌面版网站"、
        // 国产内核等），光靠媒体查询会漏。这里用 maxTouchPoints / UA 硬判定，给 body
        // 打上 dsh-canvas-touch，让 CSS 那条选择器与媒体查询互为保险。
        try {
          var nav = typeof navigator !== 'undefined' ? navigator : null;
          var ua = (nav && nav.userAgent) || '';
          var touchLike =
            (nav && (nav.maxTouchPoints || 0) > 0) ||
            /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua);
          if (touchLike && typeof document !== 'undefined' && document.body) {
            document.body.classList.add('dsh-canvas-touch');
          }
        } catch (error) {
          console.error('[dsh-canvas] 触屏打标失败（已忽略）：', error);
        }
        try {
          insertStyle();
        } catch (error) {
          console.error('[dsh-canvas] 样式注入失败（已忽略）：', error);
        }
        try {
          ctx.inject(['slots'], function (scope) {
            scope.slots.inject('shell.overlay', function () {
              return scope.slots.register(
                { name: 'shell.overlay', id: 'dsh-canvas', order: 70, label: '画布工作流' },
                CanvasWidget,
              );
            });
          });
        } catch (error) {
          console.error('[dsh-canvas] 插槽挂载失败（已忽略）：', error);
        }
      }

      // TEMPLATES 一起导出：验收脚本要拿它逐个 compile() 一遍
      var exports = {
        name: 'dsh-canvas-client',
        inject: ['slots'],
        apply: apply,
        TEMPLATES: TEMPLATES,
        normalizeIncoming: normalizeIncoming,
      };
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
      return exports;
    },
  });
})();
