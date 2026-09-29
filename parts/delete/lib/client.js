/**
 * dsh-wm-toolkit · 消息删除半边 —— 浏览器半边。
 *
 * 两个入口：
 *   * 助手回复操作区的垃圾桶，经官方 `conversation.chat.assistant-actions` 列表槽挂载
 *     （宿主会把这条消息的持久 messageId 交给它）；
 *   * 一个按会话挂载的控制器，经 `conversation.input.overlay` 渲染确认弹窗，并为
 *     宿主没有提供操作槽的行补上入口：用户消息、注入上下文行、工具调用卡、过程行、失败行。
 *
 * 行定位只用官方 `useChat` 标准 hook（ChatSnapshot 用与 DOM 相同的 `data-chat-flow-key` 作键）
 * 加官方 `data-chat-flow-*` 锚点；不读 React fiber、不依赖 CSS-modules 哈希类名，
 * 所以宿主 UI 重构不会静默失效。
 *
 * 移植自 MIT 社区插件 `dsh-delete-turn`（DDDMUC/dsh-delete-turn v0.1.3）的 src/client.js：
 * 改命名空间/路由前缀/槽 id，文案改为中文优先，并补上「软删除」语义的说明。上游版权见 NOTICE.md。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wm-delete',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { jsx, jsxs, Fragment } = jsxRuntime;

    const NS = 'wm-delete';
    const ROUTE_PREFIX = '/wm-delete';

    // 会话 id 的**形状不只有 uuid**。DSH 里外部桥接进来的会话是别的样子，实测两种：
    //   lark-link:dm:oc_2a58…:mujqtyuo8ej7:0      （飞书桥接）
    //   aa_5116dbc90b99549e_sess_aiTbvs5ZwAhL5A   （agents-anywhere）
    // 早先这里按 uuid 收紧（`^(session-)?<uuid>$`），于是这类会话在界面上"明明打开着"，
    // 点删除却在本地就被判成不可用、报「这个会话当前未激活」——而且**一个请求都不发**，
    // 宿主侧连日志都没有，极难排查。
    //
    // 所以这里只做两件事：① 挡住「新会话输入框」阶段传进来的 undefined/null（那时本来
    // 就没有会话可删，不该发请求）；② 保证 id 能安全地当路径用（下面宿主半边同样规则）。
    // 形状本身交给宿主去认——认不出来会明确回 404/409，比在本地猜准得多。
    const MAX_SESSION_ID_LENGTH = 200;
    function usableSessionId(value) {
      if (typeof value !== 'string') return false;
      const id = value.trim();
      if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH) return false;
      if (id === '.' || id === '..') return false;
      // 会话 id 会被拼进存储路径，绝不能让它穿越目录。
      return !/[\\/\u0000-\u001f\u007f]/.test(id);
    }

    // --- 文案 ------------------------------------------------------------------

    const zh = {
      'action.tooltip.message': '删除这条消息',
      'action.tooltip.step': '删除这一步',
      'action.tooltip.reply': '删除这条回复',
      'dialog.title.message': '删除这条消息？',
      'dialog.title.step': '删除这一步？',
      'dialog.title.reply': '删除这条回复？',
      'dialog.desc.message': '这条消息将从模型上下文中移除，并从当前转录中隐藏。原始会话日志保持不变。',
      'dialog.desc.step': '这一步的回复与它请求的工具结果将一并从模型上下文中移除，同一回合的其它步骤保留。',
      'dialog.desc.reply': '只删除这一段回复（含它的思考、工具调用与注入上下文）；同一轮里其它段的内容和你的提问都会保留。',
      'dialog.wholeTurn': '同时删掉这一轮里其它 {count} 段回复（你的提问全部保留）',
      'dialog.note': '删除只影响模型后续看到的内容，不会改写历史日志；被删掉的内容无法还原。',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.pending': '删除中…',
      'dialog.retry': '重试',
      'error.invalid': '请求无效，请刷新后重试。',
      'error.session-not-active': '这个会话当前未激活，请先打开该会话再删除。',
      'error.unsupported-session': '无法识别这个会话的标识，删除没有下发。请刷新页面后重试；若一直如此，请把这条提示反馈给插件作者。',
      'error.session-not-found': '找不到该会话的日志。',
      'error.busy': '该会话正在进行中，请等回复结束后再删除。',
      'error.already-deleted': '这条内容已经从上下文中删除了。',
      'error.not-deletable': '这个位置不支持删除。',
      'error.range-not-clean': '目标区间包含其它内容，已取消删除。',
      'error.nothing-to-delete': '这个回合没有可删除的回复内容。',
      'error.stale': '会话刚刚发生了变化，请重试。',
      'error.forbidden': '请求来源不被允许。',
      'error.generic': '删除失败，请重试。',
    };

    const en = {
      'action.tooltip.message': 'Delete this message',
      'action.tooltip.step': 'Delete this step',
      'action.tooltip.reply': 'Delete this reply',
      'dialog.title.message': 'Delete this message?',
      'dialog.title.step': 'Delete this step?',
      'dialog.title.reply': 'Delete this reply?',
      'dialog.desc.message': 'This message leaves the model context and is hidden from the current transcript. The original session log stays untouched.',
      'dialog.desc.step': 'This step and the tool results it requested leave the model context together; other steps in the same turn stay.',
      'dialog.desc.reply': 'Only this segment of the reply (its reasoning, tool calls and injected context) leaves the model context; the other segments of the same turn and all of your prompts stay.',
      'dialog.wholeTurn': 'Also delete the other {count} reply segments in this turn (your prompts stay)',
      'dialog.note': 'Deletion only changes what the model sees next; the append-only log is never rewritten, and deleted content cannot be restored.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.pending': 'Deleting...',
      'dialog.retry': 'Retry',
      'error.invalid': 'Invalid request; refresh and try again.',
      'error.session-not-active': 'This session is not open in DSH; open it first.',
      'error.unsupported-session': 'This session id is not usable, so nothing was sent. Refresh the page and try again.',
      'error.session-not-found': 'No session log was found for this id.',
      'error.busy': 'This session is still working; wait for the reply to finish.',
      'error.already-deleted': 'This content is already removed from the context.',
      'error.not-deletable': 'This position cannot be deleted.',
      'error.range-not-clean': 'The target window contains unrelated content; the delete was cancelled.',
      'error.nothing-to-delete': 'This turn has no reply content to delete.',
      'error.stale': 'The session just changed; try again.',
      'error.forbidden': 'The request origin is not allowed.',
      'error.generic': 'Delete failed; try again.',
    };

    // --- 样式 ------------------------------------------------------------------

    const CSS = [
      '.dshwd-action{width:28px;height:28px;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;transition:background-color .12s,color .12s}',
      '.dshwd-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshwd-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);outline-offset:2px}',
      '.dshwd-action:disabled{cursor:default;opacity:.4}',
      '.dshwd-action svg{width:15px;height:15px}',
      '.dshwd-action-host{display:inline-flex;align-items:center;justify-content:center}',
      // 插进已有操作条时（用户消息的「撤回 / 复制」那一排）：尺寸与圆角对齐旁边的按钮，
      // 且常显不透明——浮在行上的按钮会压住原有按钮，既难看又难点。
      '.dshwd-inline{display:inline-flex;align-items:center;justify-content:center}',
      '.dshwd-inline .dshwd-action{width:34px;height:34px;padding:0;border-radius:8px}',
      '.dshwd-row{position:relative}',
      '.dshwd-floating{position:absolute;top:2px;right:6px;z-index:2;opacity:0;transition:opacity .12s}',
      '.dshwd-row:hover .dshwd-floating,.dshwd-floating:focus-within{opacity:1}',
      '[data-variant="think"]{position:relative}',
      '.dshwd-think-action{position:absolute;top:0;right:4px;opacity:0;transition:opacity .12s}',
      '[data-variant="think"]:hover .dshwd-think-action,.dshwd-think-action:focus-within{opacity:1}',
      '.dshwd-collapsing{overflow:hidden;transition:height .2s ease,opacity .14s ease,margin .2s ease,padding .2s ease}',
      '[data-dshwd-hidden="1"]{display:none!important}',
      '[data-dshwd-no-target="1"] .dshwd-action{display:none!important}',
      '.dshwd-dialog-text{margin:0;color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:22px}',
      '.dshwd-dialog-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:13px;line-height:20px}',
      '.dshwd-dialog-option{margin:12px 0 0;display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px;cursor:pointer}',
      '.dshwd-dialog-checkbox{margin:3px 0 0;flex:none;accent-color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshwd-dialog-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary,#d54941);font-size:13px;line-height:20px}',
      '.dshwd-danger{background:var(--dsw-alias-state-error-primary,#d54941)!important;color:var(--dsw-alias-label-primary-foreground,#fff)!important}',
      '@media (prefers-reduced-motion:reduce){.dshwd-collapsing{transition:none}.dshwd-floating{transition:none}}',
    ].join('');

    const TAG_ID = 'dsh-wm-toolkit/wm-delete.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // --- 图标 ------------------------------------------------------------------

    // 手绘垃圾桶：盖线、梯形桶身、两根加强筋。
    const ICON_PATHS = [
      'M6.4 2.6h3.2',
      'M2.9 4.6h10.2',
      'M4.4 4.6l.62 7.55A1.6 1.6 0 0 0 6.61 13.6h2.78a1.6 1.6 0 0 0 1.59-1.45l.62-7.55',
      'M6.8 7.1v3.6',
      'M9.2 7.1v3.6',
    ];
    const ICON_MARKUP =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      ICON_PATHS.map(
        (d) =>
          '<path d="' + d + '" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
      ).join('') +
      '</svg>';

    function TrashIcon() {
      return jsx('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        children: ICON_PATHS.map((d, index) =>
          jsx('path', { d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }, index),
        ),
      });
    }

    // --- 控制器 ----------------------------------------------------------------

    class DeletionController {
      constructor(sessionId) {
        this.sessionId = sessionId;
        this.listeners = new Set();
        this.inflight = null;
        this.animateOnce = false;
        /** surface 抓取之后的防抖刷新计时器（见 scheduleRefresh）。 */
        this.refreshTimer = null;
        this.view = Object.freeze({
          hidden: new Map(),
          surface: new Set(),
          replyTurns: new Set(),
          // 已经被删空、只剩提问的回合。这些回合里"映射不到 surface 节点"的行
          // （客户端合成的过程分组壳、模型重试行、中断的工具行）只能按回合号整体收起。
          clearedTurns: new Set(),
          // 每一段回复的段尾 seq（宿主给出）。只有段尾那一行长「删除这段回复」按钮，
          // 于是"回合中途插话之前的那些段"也有自己的入口，而不是只有回合结尾才有。
          segmentTails: new Set(),
          // 每个可删回合被切成几段回复：>1 时确认框才提供「同时删掉这一轮其它回复段」。
          segmentsByTurn: {},
          // 确认框里的「整轮删除」勾选状态（默认关闭＝只删被点的那一段）。
          wholeTurn: false,
          // 上次抓 surface 时的日志末尾 seq。用来识别"抓完之后又产生了新内容"——
          // 那些内容的 seq 不在 surface 里，但绝不能因此被判成不可删（否则刚发出的消息、
          // 刚完成的回复都没有删除入口，要重启 DSH 才出现）。
          lastSeq: -1,
          surfaceReady: false,
          loaded: false,
          loadError: false,
          dialog: null,
          pending: false,
          failure: null,
          revision: 0,
        });
      }

      getSnapshot = () => this.view;

      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      };

      publish(patch) {
        this.view = Object.freeze({ ...this.view, ...patch, revision: this.view.revision + 1 });
        for (const listener of this.listeners) {
          try {
            listener();
          } catch (error) {
            console.error('[wm-delete] subscriber threw:', error);
          }
        }
      }

      consumeAnimate() {
        const value = this.animateOnce === true;
        this.animateOnce = false;
        return value;
      }

      load(force) {
        // 没有可用会话 id：不发请求，直接标成"已加载但没有 surface 信息"，
        // 界面照常渲染（此时本来也没有可删的消息行）。
        if (!usableSessionId(this.sessionId)) {
          if (!this.view.loaded) this.publish({ loaded: true, surfaceReady: false, loadError: false });
          return Promise.resolve();
        }
        if (this.inflight !== null) return this.inflight;
        if (this.view.loaded && force !== true) return Promise.resolve();
        const url = `${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(this.sessionId)}`;
        const pending = fetch(url, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`);
            const hidden = new Map();
            for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
              if (item && typeof item.seq === 'number') hidden.set(item.seq, typeof item.mode === 'string' ? item.mode : 'message');
            }
            const surface = new Set();
            for (const seq of Array.isArray(data.surface) ? data.surface : []) surface.add(seq);
            const replyTurns = new Set();
            for (const turn of Array.isArray(data.replyTurns) ? data.replyTurns : []) replyTurns.add(turn);
            const clearedTurns = new Set();
            for (const turn of Array.isArray(data.clearedTurns) ? data.clearedTurns : []) {
              if (typeof turn === 'number') clearedTurns.add(turn);
            }
            const segmentTails = new Set();
            for (const seq of Array.isArray(data.segmentTails) ? data.segmentTails : []) {
              if (typeof seq === 'number') segmentTails.add(seq);
            }
            const segmentsByTurn = {};
            if (data.segmentsByTurn !== null && typeof data.segmentsByTurn === 'object') {
              for (const [turn, count] of Object.entries(data.segmentsByTurn)) {
                if (Number.isFinite(Number(turn)) && typeof count === 'number' && count > 0) segmentsByTurn[Number(turn)] = count;
              }
            }
            this.publish({
              hidden,
              surface,
              replyTurns,
              clearedTurns,
              segmentTails,
              segmentsByTurn,
              lastSeq: typeof data.lastSeq === 'number' ? data.lastSeq : -1,
              surfaceReady: true,
              loaded: true,
              loadError: false,
            });
          })
          .catch(() => {
            this.publish({ loadError: true });
          })
          .finally(() => {
            this.inflight = null;
          });
        this.inflight = pending;
        return pending;
      }

      /**
       * 防抖地重新抓一次 surface。
       *
       * 为什么要防抖：流式回复期间 chat 快照每个 token 都在变、新 seq 不断出现，
       * 每次都发请求会把 `/wm-delete/state` 刷爆。这里把多次请求合并成"内容稳定后的一次"——
       * 期间按钮由 {@link rowDeletable} 的乐观放行保证可见，刷新只负责精确校正
       * （例如排除已经被 /compact 移出上下文的内容）。
       */
      scheduleRefresh() {
        if (!usableSessionId(this.sessionId)) return;
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          this.load(true);
        }, 800);
      }

      open(target) {
        this.load();
        // 每次打开都从「只删这一段」开始：整轮删除必须显式勾选，绝不默认扩大范围。
        this.publish({ dialog: target, failure: null, wholeTurn: false });
      }

      setWholeTurn(value) {
        this.publish({ wholeTurn: value === true });
      }

      close() {
        if (this.view.pending) return;
        this.publish({ dialog: null, failure: null });
      }

      async confirm() {
        const target = this.view.dialog;
        if (target === null || this.view.pending) return;
        if (!usableSessionId(this.sessionId)) {
          // 本地拦截时宿主一条日志都不会有（请求根本没发），所以这里必须吭一声：
          // 排查线上问题时，宿主日志干干净净反而会被误读成「请求被拒」。
          try {
            console.warn('[wm-delete] 会话标识不可用，已取消删除，未向宿主下发请求：', this.sessionId);
          } catch {
            /* ignore */
          }
          this.publish({ pending: false, failure: 'unsupported-session' });
          return;
        }
        this.publish({ pending: true, failure: null });
        // scope 只在勾了「整轮」时下发；不勾就等于 segment（宿主默认也只认 segment）。
        const request = this.view.wholeTurn === true && target.mode === 'reply'
          ? { ...target, scope: 'turn' }
          : target;
        try {
          const res = await fetch(`${ROUTE_PREFIX}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, ...request }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            this.publish({ pending: false, failure: data && data.code ? String(data.code) : 'generic' });
            return;
          }
          const hidden = new Map(this.view.hidden);
          for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
            if (item && typeof item.seq === 'number') hidden.set(item.seq, typeof item.mode === 'string' ? item.mode : target.mode);
          }
          // 宿主随删除结果一并回报"已经被删空的回合"，过程分组壳与重试行当场就能收起；
          // 万一宿主没给（旧版本），还有一次防抖刷新兜底。
          const clearedTurns = new Set(this.view.clearedTurns);
          for (const turn of Array.isArray(data.clearedTurns) ? data.clearedTurns : []) {
            if (typeof turn === 'number') clearedTurns.add(turn);
          }
          this.animateOnce = true;
          this.publish({ pending: false, dialog: null, hidden, clearedTurns, loaded: true, loadError: false });
          if (!Array.isArray(data.clearedTurns)) this.scheduleRefresh();
        } catch {
          this.publish({ pending: false, failure: 'generic' });
        }
      }

      dispose() {
        if (this.refreshTimer !== null) {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = null;
        }
        this.listeners.clear();
      }
    }

    // --- 行目标 ----------------------------------------------------------------

    /**
     * 一个 Chat 视图节点可以请求删除什么；不可删的行（系统提示词头、进行中的步骤）返回 null。
     *
     * reply 的两种范围：
     *   - 行上的垃圾桶永远是 **scope: 'segment'** —— 只删你点的这一段回复（所见即所得）；
     *   - **scope: 'turn'** 只在确认框里勾选「同时删掉这一轮其它回复段」时加上。
     */
    function targetFor(node, view) {
      const data = node.data || {};
      const turn = typeof data.turn === 'number' ? data.turn : undefined;
      const withTurn = (target) => (turn === undefined ? target : { ...target, turn });
      switch (node.kind) {
        case 'user':
        case 'context':
        case 'steering': {
          const seq = typeof data.seq === 'number' ? data.seq : node.anchorSeq;
          return typeof seq === 'number' ? { mode: 'message', seq, label: 'message' } : null;
        }
        case 'tool-call': {
          const root = data.root;
          const seq = root && typeof root.seq === 'number' ? root.seq : undefined;
          return seq === undefined ? null : { mode: 'step', seq, label: 'step' };
        }
        case 'turn-process': {
          // 过程折叠条锚在**这一轮的答案**上（最后一段的段尾），点它删最后那一段。
          const anchor = typeof data.answerAnchorSeq === 'number' ? data.answerAnchorSeq : undefined;
          if (anchor !== undefined) return withTurn({ mode: 'reply', seq: anchor, label: 'reply' });
          return turn === undefined ? null : { mode: 'reply', turn, label: 'reply' };
        }
        case 'turn-error':
        case 'model-retry':
          return turn === undefined ? null : { mode: 'reply', turn, label: 'reply' };
        case 'turn-tail': {
          const closing = data.closing;
          // closing.finalNode.messageId 存在时交给官方助手操作条（它的删除按钮就是删这一段）。
          if (closing && closing.finalNode && closing.finalNode.messageId !== undefined) return null;
          return turn === undefined ? null : { mode: 'reply', turn, label: 'reply' };
        }
        case 'assistant-step': {
          const final = data.finalNode;
          const seq = final && typeof final.seq === 'number' ? final.seq : undefined;
          if (seq === undefined) return null;
          // 每一条回复都要有自己的「删除这段回复」入口：回合中途插话之前的那些段没有回合尾行，
          // 官方助手操作条也只长在回合尾行上，所以只删一段的入口必须挂在这一行自己身上。
          // 只挂**段尾**那一行（宿主用 segmentTails 报出段尾 seq）——每段恰好一个入口，
          // 段中间的步骤行不重复长按钮（那些行的精细删除走思考卡 / 工具卡的「删这一步」）。
          // surface 还没抓回来时（segmentTails 为空）保持旧行为，由官方槽提供入口。
          if (view !== undefined && view.segmentTails.size > 0 && !view.segmentTails.has(seq)) return null;
          return withTurn({ mode: 'reply', seq, label: 'reply' });
        }
        default:
          return null;
      }
    }

    function seqsFor(node) {
      const data = node.data || {};
      const out = [];
      const push = (value) => {
        if (typeof value === 'number' && !out.includes(value)) out.push(value);
      };
      switch (node.kind) {
        case 'user':
        case 'context':
        case 'steering':
          push(data.seq);
          break;
        case 'assistant-step':
          push(node.anchorSeq);
          if (data.finalNode) push(data.finalNode.seq);
          break;
        case 'tool-call':
          if (data.root) push(data.root.seq);
          break;
        case 'turn-tail':
          push(node.anchorSeq);
          if (data.closing && data.closing.finalNode) push(data.closing.finalNode.seq);
          break;
        case 'turn-process':
          // 过程折叠条跟着它的答案一起隐藏：只删步骤时答案还在，行保留；
          // 删整条回复时答案没了，行塌掉。
          push(data.answerAnchorSeq);
          break;
        default:
          push(node.anchorSeq);
      }
      return out;
    }

    function isRowHidden(hidden, seqs) {
      for (const seq of seqs) {
        if (hidden.has(seq)) return true;
      }
      return false;
    }

    /** 真人输入类行：回合被删空时也要留下（方案一：留 A 与中途补发的 C）。 */
    const INPUT_ROW_KINDS = new Set(['user', 'steering', 'turn-trigger']);

    /** 行上的回合号（宿主给每个 flow item 都发了 `data-chat-turn`）。 */
    function rowTurnOf(row) {
      const raw = row.getAttribute('data-chat-turn');
      if (raw === null || raw === '') return undefined;
      const turn = Number(raw);
      return Number.isFinite(turn) ? turn : undefined;
    }

    /**
     * 这一行是否属于「已经被删空的回合」。
     *
     * 转录里有一类行**映射不到 surface 节点**：客户端自己合成的过程分组壳
     * （`data-step-process`，标题就是「执行了命令 / 已完成分析」）、模型重试行、中断的
     * 工具行。它们的锚点是 `tool/call`、`llm/retry` 这类非 surface 事件，或者干脆是
     * 客户端合成的分组键，按 seq 永远判不出来 —— 结果就是"AI 回复删了，壳还杵在那儿"。
     * 这些行都带 `data-chat-turn`，所以整回合按回合号收起（真人输入行除外）。
     */
    function isClearedRow(row, node, view) {
      if (view.clearedTurns.size === 0) return false;
      if (node !== undefined && node !== null && INPUT_ROW_KINDS.has(node.kind)) return false;
      const turn = rowTurnOf(row);
      return turn !== undefined && view.clearedTurns.has(turn);
    }

    /**
     * 过程分组壳是不是已经没有活着的成员了。
     *
     * 宿主把组成员（工具卡、思考行、过程行）渲染在分组行**内部**，成员自己也带
     * `[data-chat-flow-key]`，所以按文档顺序先处理完成员、再看结果即可：组里每个成员
     * 都已被本插件隐藏 → 壳一起收掉。还没渲染出成员时不判定（避免误伤）。
     */
    function groupFullyHidden(row) {
      const members = row.querySelectorAll('[data-chat-flow-key]');
      if (members.length === 0) return false;
      for (const member of members) {
        if (member.dataset.dshwdHidden !== '1') return false;
      }
      return true;
    }

    // --- DOM 增强 --------------------------------------------------------------

    const rowActions = new WeakMap();
    const thinkActions = new WeakMap();

    function setRowHidden(row, hide, animate) {
      if (hide) {
        if (row.dataset.dshwdHidden === '1') return;
        row.dataset.dshwdHidden = '1';
        if (!animate || typeof requestAnimationFrame !== 'function') {
          row.style.display = 'none';
          return;
        }
        const height = row.getBoundingClientRect().height;
        row.classList.add('dshwd-collapsing');
        row.style.height = `${height}px`;
        row.style.opacity = '1';
        requestAnimationFrame(() => {
          row.style.height = '0px';
          row.style.opacity = '0';
          row.style.marginTop = '0px';
          row.style.marginBottom = '0px';
          row.style.paddingTop = '0px';
          row.style.paddingBottom = '0px';
        });
        window.setTimeout(() => {
          if (row.dataset.dshwdHidden !== '1') return;
          row.classList.remove('dshwd-collapsing');
          row.style.display = 'none';
        }, 240);
        return;
      }
      if (row.dataset.dshwdHidden !== '1') return;
      delete row.dataset.dshwdHidden;
      row.classList.remove('dshwd-collapsing');
      row.style.display = '';
      row.style.height = '';
      row.style.opacity = '';
      row.style.marginTop = '';
      row.style.marginBottom = '';
      row.style.paddingTop = '';
      row.style.paddingBottom = '';
    }

    function removeRowAction(row) {
      const entry = rowActions.get(row);
      if (!entry) return;
      entry.host.remove();
      rowActions.delete(row);
    }

    /**
     * 找到这一行的「操作条」，把删除按钮**插进去**（排在现有按钮后面）。
     *
     * 两种来源：
     *   1. **官方气泡的操作条**：CSS-modules 类名里带 `_actions`，里面确实有按钮。
     *   2. **本仓库 recall 半边自绘的用户气泡**：它顶替了 `conversation.chat.node` 的
     *      `user` 格，操作条是纯内联样式（`display:flex;gap:2px`），**没有任何类名**，
     *      所以上面那条选择器匹配不到。这里改用它的稳定标记：操作条里必有那个
     *      `data-dsh-message-recall="recall-key"` 的「撤回」按钮，从它往上找到直接挂在
     *      气泡根节点下的那一层即可（正常态与编辑态都成立，且不会误命中编辑器的取消/确认行）。
     *
     * 找不到就返回 null，由调用方回落到行内浮层按钮。
     * @param row - 一行 `[data-chat-flow-key]` 元素。
     * @returns 操作条元素，或 null。
     */
    function findRowActions(row) {
      const official = row.querySelector('[class*="_actions"]');
      if (official && official.querySelector('button')) return official;
      const bubble = row.querySelector('[data-dsh-message-recall="user"]');
      if (!bubble) return null;
      const recallKey = bubble.querySelector('[data-dsh-message-recall="recall-key"]');
      if (!recallKey) return null;
      let node = recallKey.parentElement;
      while (node && node.parentElement !== bubble) node = node.parentElement;
      if (node && node.parentElement === bubble && node.querySelector('button')) return node;
      return null;
    }

    function injectRowAction(row, node, target, controller, t) {
      const label = t(`action.tooltip.${target.label}`);
      let entry = rowActions.get(row);
      if (!entry) {
        const host = document.createElement('span');
        host.className = 'dshwd-action-host';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dshwd-action dshwd-row-action';
        button.innerHTML = ICON_MARKUP;
        host.appendChild(button);
        entry = { host, button };
        rowActions.set(row, entry);
      }
      const { host, button } = entry;
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
      }
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.open(target);
      };
      // 优先插进这一行已有的操作条（用户消息就是「撤回 / 复制」那一排，删除排在它们后面）；
      // 实在找不到操作条的行（注入上下文行、工具卡、过程行…）才回落到行内浮层按钮。
      const anchor = findRowActions(row);
      if (anchor) {
        host.classList.remove('dshwd-floating');
        host.classList.add('dshwd-inline');
        row.classList.remove('dshwd-row');
        if (host.parentElement !== anchor) anchor.appendChild(host);
      } else {
        host.classList.remove('dshwd-inline');
        host.classList.add('dshwd-floating');
        row.classList.add('dshwd-row');
        if (host.parentElement !== row) row.appendChild(host);
      }
    }

    function removeThinkAction(think) {
      const entry = thinkActions.get(think);
      if (!entry) return;
      entry.host.remove();
      thinkActions.delete(think);
    }

    // 思考行活在它所属的助手消息里：它的入口瞄准外层步骤，所以多步回合可以只丢掉
    // 某一步的思考与工具工作，而不动其它步骤。
    function injectThinkAction(think, target, controller, t) {
      const label = t('action.tooltip.step');
      let entry = thinkActions.get(think);
      if (!entry) {
        const host = document.createElement('span');
        host.className = 'dshwd-action-host dshwd-think-action';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dshwd-action dshwd-row-action';
        button.innerHTML = ICON_MARKUP;
        host.appendChild(button);
        entry = { host, button };
        thinkActions.set(think, entry);
      }
      const { host, button } = entry;
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
      }
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.open(target);
      };
      if (host.parentElement !== think) think.appendChild(host);
    }

    /**
     * 这一行是否承载着"surface 抓取之后才出现"的新内容。
     *
     * 判据：行的 surface seq 比上次抓取时的日志末尾（`view.lastSeq`）还大。
     * 这类内容不可能出现在旧 surface 里，用旧 surface 判"不可删"会把刚发出的消息、
     * 刚完成的回复的删除入口全部藏掉——表现为"必须重启 DSH 才出现删除按钮"。
     */
    function isNewContent(seqs, view) {
      if (typeof view.lastSeq !== 'number' || view.lastSeq < 0) return false;
      return seqs.some((seq) => typeof seq === 'number' && seq > view.lastSeq);
    }

    // 只有内容还在模型上下文里时才提供入口：官方 /compact（或别的生产者）可以把一个回合
    // 移出 surface，而转录行是刻意保留显示的。
    function rowDeletable(node, seqs, view) {
      if (!view.surfaceReady) return true;
      // 新内容先乐观放行。surface 抓取是异步的：这里是"立即显示按钮"，
      // applyDom 会同时安排一次防抖刷新，下一帧再用新 surface 精确校正。
      if (isNewContent(seqs, view)) return true;
      const data = node.data || {};
      if (node.kind === 'turn-tail' || node.kind === 'turn-process' || node.kind === 'turn-error' || node.kind === 'model-retry') {
        if (typeof data.turn === 'number') return view.replyTurns.has(data.turn);
      }
      return seqs.some((seq) => view.surface.has(seq));
    }

    function slotCoversRow(node) {
      if (node.kind !== 'turn-tail') return false;
      const closing = node.data && node.data.closing;
      return Boolean(closing && closing.finalNode && closing.finalNode.messageId !== undefined);
    }

    function applyDom(snapshot, view, controller, t) {
      if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') return;
      const animate = controller.consumeAnimate();
      const rows = document.querySelectorAll('[data-chat-flow-key]');
      // 这一帧里有没有"surface 抓取之后才出现"的内容。有就安排一次防抖刷新，
      // 让下一帧的判定建立在最新 surface 上（按钮本身已由乐观放行显示出来）。
      let sawNewContent = false;
      // 查不到快照节点的合成行（过程分组壳）留到第二遍：它们的成员渲染在它们内部，
      // 文档顺序保证成员先被处理，第二遍才能看到"组里还有没有活着的成员"。
      const syntheticRows = [];
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue;
        const key = row.getAttribute('data-chat-flow-key');
        if (!key) continue;
        // 一行的 flow key 不一定是裸节点键：宿主给「思考」分组行发的是
        // JSON.stringify([nodeKey, groupPart])，而 data-chat-node-key 始终是裸键。
        // 只用 flow key 查快照，这类行就查不到节点 —— 于是被删掉之后永远不隐藏
        // （也没有删除入口），表现为转录上留下"删不掉的思考行"。
        const node = snapshot.nodes.get(key) ?? snapshot.nodes.get(row.getAttribute('data-chat-node-key') ?? '');
        if (!node) {
          if (row.getAttribute('data-step-process') !== null) syntheticRows.push(row);
          continue;
        }
        const seqs = seqsFor(node);
        if (isNewContent(seqs, view)) sawNewContent = true;
        // 两条判据：seq 命中隐藏台账（精确），或者整个回合已经被删空（兜住那些
        // 压根映射不到 surface 节点的行：重试行、中断的工具行、过程行）。
        const hidden = isRowHidden(view.hidden, seqs) || isClearedRow(row, node, view);
        setRowHidden(row, hidden, animate);
        const target = hidden ? null : targetFor(node, view);
        const covered = target !== null || slotCoversRow(node);
        const deletable = !hidden && covered && rowDeletable(node, seqs, view);
        if (deletable && target !== null) injectRowAction(row, node, target, controller, t);
        else removeRowAction(row);
        if (!hidden && covered && !rowDeletable(node, seqs, view)) row.dataset.dshwdNoTarget = '1';
        else delete row.dataset.dshwdNoTarget;
      }
      for (const row of syntheticRows) {
        setRowHidden(row, isClearedRow(row, undefined, view) || groupFullyHidden(row), animate);
      }
      for (const think of document.querySelectorAll('[data-variant="think"]')) {
        const row = think.closest('[data-chat-flow-key]');
        const node = row
          ? snapshot.nodes.get(row.getAttribute('data-chat-flow-key')) ?? snapshot.nodes.get(row.getAttribute('data-chat-node-key') ?? '')
          : undefined;
        const final = node && node.kind === 'assistant-step' ? node.data.finalNode : undefined;
        const seq = final && typeof final.seq === 'number' ? final.seq : undefined;
        if (typeof seq === 'number' && isNewContent([seq], view)) sawNewContent = true;
        const allowed = seq !== undefined && !view.hidden.has(seq)
          && (!view.surfaceReady || isNewContent([seq], view) || view.surface.has(seq));
        if (!allowed) removeThinkAction(think);
        else injectThinkAction(think, { mode: 'step', seq, label: 'step' }, controller, t);
      }
      // 看到新内容 → 安排一次防抖刷新，把 surface 追到最新。
      // 放在最后：一帧只调度一次（scheduleRefresh 内部还会合并多次调用）。
      if (sawNewContent) controller.scheduleRefresh();
    }

    // --- React 入口 ------------------------------------------------------------

    function AssistantAction({ messageId, useDeletion, controller, t }) {
      const view = useDeletion((state) => state);
      const label = t('action.tooltip.reply');
      return jsx('button', {
        type: 'button',
        className: 'dshwd-action',
        'aria-label': label,
        title: label,
        disabled: view.pending,
        onClick: () => controller.open({ mode: 'reply', messageId }),
        children: jsx(TrashIcon, {}),
      });
    }

    function ConfirmDialog({ view, controller, t }) {
      const target = view.dialog;
      const mode = target && typeof target.mode === 'string' ? target.mode : 'message';
      const failure = view.failure;
      // 只有 reply 才可能有多段：这一轮被真人提问切成了几段（>1 才提供整轮选项）。
      const turn = target && typeof target.turn === 'number' ? target.turn : undefined;
      const segments = turn === undefined ? 0 : view.segmentsByTurn[turn] ?? 0;
      const wholeTurnOption = mode === 'reply' && segments > 1
        ? jsxs('label', {
            className: 'dshwd-dialog-option',
            children: [
              jsx('input', {
                type: 'checkbox',
                className: 'dshwd-dialog-checkbox',
                checked: view.wholeTurn === true,
                disabled: view.pending,
                onChange: (event) => controller.setWholeTurn(event.target.checked),
              }),
              jsx('span', { children: t('dialog.wholeTurn', { count: segments }) }),
            ],
          })
        : null;
      return jsx(primitives.Modal, {
        open: target !== null,
        title: t(`dialog.title.${mode}`),
        closeLabel: t('dialog.cancel'),
        onClose: () => controller.close(),
        footer: jsxs(Fragment, {
          children: [
            jsx(primitives.Button, {
              variant: 'ghost',
              size: 'md',
              disabled: view.pending,
              onClick: () => controller.close(),
              children: t('dialog.cancel'),
            }),
            jsx(primitives.Button, {
              variant: 'primary',
              size: 'md',
              className: 'dshwd-danger',
              disabled: view.pending,
              onClick: () => controller.confirm(),
              children: view.pending ? t('dialog.pending') : failure ? t('dialog.retry') : t('dialog.confirm'),
            }),
          ],
        }),
        children: jsxs(Fragment, {
          children: [
            jsx('p', { className: 'dshwd-dialog-text', children: t(`dialog.desc.${mode}`) }),
            wholeTurnOption,
            jsx('p', { className: 'dshwd-dialog-note', children: t('dialog.note') }),
            failure === null
              ? null
              : jsx('p', { className: 'dshwd-dialog-error', role: 'status', children: t(`error.${failure}`) }),
          ],
        }),
      });
    }

    function OverlayEntry({ useChat, useDeletion, controller, t }) {
      const snapshot = typeof useChat === 'function' ? useChat((state) => state) : undefined;
      const view = useDeletion((state) => state);

      react.useEffect(() => {
        controller.load();
      }, [controller]);

      react.useEffect(() => {
        if (snapshot === undefined) return undefined;
        let scheduled = false;
        const run = () => {
          scheduled = false;
          applyDom(snapshot, view, controller, t);
        };
        run();
        const observer = new MutationObserver(() => {
          if (scheduled) return;
          scheduled = true;
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
          else window.setTimeout(run, 16);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
        };
      }, [snapshot, view, controller, t]);

      return jsxs(Fragment, {
        children: [jsx('span', { hidden: true }), jsx(ConfirmDialog, { view, controller, t })],
      });
    }

    // --- 插件 ------------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'wm-delete: dictionaries');

      const controllers = new Map();
      const controllerFor = (sessionId) => {
        // 用 '' 兜住 undefined/null：新会话输入框阶段拿不到 sessionId，那时控制器是惰性的。
        const key = usableSessionId(sessionId) ? sessionId : '';
        let controller = controllers.get(key);
        if (controller === undefined) {
          controller = new DeletionController(key);
          controllers.set(key, controller);
        }
        return controller;
      };
      ctx.effect(
        () => () => {
          for (const controller of controllers.values()) controller.dispose();
          controllers.clear();
        },
        'wm-delete: per-session controllers',
      );

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'wm-delete-reply',
            order: 30,
            locale: NS,
            inject: (sessionId) => ({ hooks: { deletion: controllerFor(sessionId) }, controller: controllerFor(sessionId) }),
          },
          AssistantAction,
        ),
      );

      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'wm-delete',
            order: 8,
            locale: NS,
            inject: (sessionId) => ({ hooks: { deletion: controllerFor(sessionId) }, controller: controllerFor(sessionId) }),
          },
          OverlayEntry,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  }
});
