/**
 * V13 阶段 5.2 — W 类飞书确认 (permission)
 *
 * 写操作流程:
 *   1. user 发 "模拟买 600519" → parser 解析成 {tool: 'paper.submitTrade', args: {...}}
 *   2. W 类 → permission.askConfirm(openId, tool, args) → 发飞书卡片 (含 ✅/❌ 按钮)
 *   3. 卡片 click action 回调 → permission.handleAction(askId, action) → resolve / reject
 *   4. 超时 (默认 5 分钟) → auto-cancel
 *
 * 用法:
 *   const ok = await permission.askConfirm(openId, 'paper.submitTrade', {code: '600519', shares: 100}, feishuApp);
 *   if (!ok) throw new Error('用户取消');
 *   // 执行写操作
 *
 * 依赖:
 *   - FeishuApp (sendCard + onMessage)
 *   - 卡片 action.value = { askId, tool, decision: 'confirm'|'cancel' }
 */
'use strict';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 分钟

class Permission {
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this._asks = new Map();   // askId -> { openId, tool, args, resolve, reject, timer }
    this._feishuApp = null;   // 由 attachTo() 注入
    this._seq = 0;
  }

  /** 注入飞书 app (用于发卡片 + 收回调) */
  attachTo(feishuApp) {
    this._feishuApp = feishuApp;
  }

  _genAskId() {
    this._seq++;
    return 'ask-' + Date.now() + '-' + this._seq;
  }

  /**
   * 发起 W 类确认请求
   * @param {string} openId 触发用户
   * @param {string} tool 工具名
   * @param {object} args 参数
   * @returns {Promise<boolean>} true=确认 / false=取消/超时
   */
  async askConfirm(openId, tool, args) {
    if (!this._feishuApp) throw new Error('[Permission] feishu app 未 attachTo');
    const askId = this._genAskId();

    // 构造卡片 (header + 工具描述 + ✅/❌ 按钮)
    const argsPreview = JSON.stringify(args).slice(0, 300);
    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '⚠️ 写操作确认 (W 类)' }
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**工具**: ' + tool + '\n**参数**: ' + argsPreview }
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 确认执行' },
              type: 'primary',
              value: { askId, tool, decision: 'confirm' }
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 取消' },
              type: 'danger',
              value: { askId, tool, decision: 'cancel' }
            }
          ]
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: '5 分钟内未操作将自动取消 (askId=' + askId + ')' }
          ]
        }
      ]
    };

    const r = await this._feishuApp.sendCard(openId, card);
    if (!r.ok) {
      throw new Error('[Permission] 发卡片失败: ' + r.error);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._asks.has(askId)) {
          this._asks.delete(askId);
          console.log('[Permission] 超时自动取消: ' + askId);
          resolve(false);
        }
      }, this.timeoutMs);
      this._asks.set(askId, { openId, tool, args, resolve, timer, cardMessageId: r.messageId });
    });
  }

  /**
   * 处理飞书卡片回调 (用户在卡片点 ✅/❌ 时触发)
   * @param {string} askId
   * @param {string} decision 'confirm' | 'cancel'
   * @returns {boolean} 是否处理了
   */
  handleAction(askId, decision) {
    const ask = this._asks.get(askId);
    if (!ask) return false;
    clearTimeout(ask.timer);
    this._asks.delete(askId);
    const ok = (decision === 'confirm');
    console.log('[Permission] askId=' + askId + ' ' + (ok ? '确认' : '取消'));
    ask.resolve(ok);
    return true;
  }

  /**
   * 主动取消某个 ask (例如用户发文本 "取消")
   */
  cancel(askId) {
    return this.handleAction(askId, 'cancel');
  }

  /**
   * 当前所有 pending asks (调试/状态查询)
   */
  status() {
    const out = [];
    for (const [id, ask] of this._asks) {
      out.push({
        askId: id,
        openId: ask.openId,
        tool: ask.tool,
        args: ask.args,
        ageMs: Date.now() - (ask.cardMessageId ? 0 : 0)   // 简化: 不记录开始时间
      });
    }
    return out;
  }

  /** 清空所有 asks (退出时) */
  clearAll() {
    for (const [, ask] of this._asks) {
      clearTimeout(ask.timer);
      ask.resolve(false);
    }
    this._asks.clear();
  }
}

module.exports = { Permission, DEFAULT_TIMEOUT_MS };