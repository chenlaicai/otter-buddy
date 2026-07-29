/** 卡片桥脚本源码（注入 iframe srcdoc）
 *  桥只是便利 API，不是安全边界——桥与 AI 脚本同上下文可被伪造，一切校验在父页。
 *  cardId 由宿主组装 srcdoc 时经 buildCardBridgeScript 注入（JSON.stringify 转义） */

const CARD_ID_PLACEHOLDER = '"__OTTER_CARD_ID__"'

/** cardId 契约格式：{messageId}:{fenceIndex}（fenceIndex 为 0 基数字） */
export const CARD_ID_RE = /^[\w-]+:\d+$/

/** resize 段：高度上报（所有可交互卡片都需要，不含提交能力） */
const CARD_RESIZE_SCRIPT = `(function () {
  var CARD_ID = "__OTTER_CARD_ID__";
  function report() {
    var h = 0;
    if (document.body) h = Math.max(h, document.body.scrollHeight);
    if (document.documentElement) h = Math.max(h, document.documentElement.scrollHeight);
    parent.postMessage({ type: 'card:resize', cardId: CARD_ID, height: h }, '*');
  }
  if (typeof ResizeObserver !== 'undefined' && document.body) {
    new ResizeObserver(report).observe(document.body);
  }
  window.addEventListener('load', report);
  report();
})();`

/** submit 段：仅在 cardId 格式合法时注入（fail-closed） */
const CARD_SUBMIT_SCRIPT = `(function () {
  var CARD_ID = "__OTTER_CARD_ID__";
  window.otterCard = {
    submit: function (payload) {
      parent.postMessage({ type: 'card:submit', cardId: CARD_ID, payload: payload }, '*');
    }
  };
})();`

export const CARD_BRIDGE_SCRIPT = CARD_RESIZE_SCRIPT + '\n' + CARD_SUBMIT_SCRIPT

/** 组装注入 cardId 后的桥脚本（占位符带引号，替换值经 JSON.stringify 转义）。
 *  cardId 不符合契约格式时 fail-closed：退化为只 resize 的只读版本（无 otterCard.submit），
 *  且畸形 cardId 绝不注入脚本上下文 */
export function buildCardBridgeScript(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) return CARD_RESIZE_SCRIPT
  return CARD_BRIDGE_SCRIPT.split(CARD_ID_PLACEHOLDER).join(JSON.stringify(cardId))
}
