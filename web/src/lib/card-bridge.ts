/** 卡片桥脚本源码（注入 iframe srcdoc）
 *  桥只是便利 API，不是安全边界——桥与 AI 脚本同上下文可被伪造，一切校验在父页。
 *  cardId 由宿主组装 srcdoc 时经 buildCardBridgeScript 注入（JSON.stringify 转义） */

const CARD_ID_PLACEHOLDER = '"__OTTER_CARD_ID__"'

export const CARD_BRIDGE_SCRIPT = `(function () {
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
  window.otterCard = {
    submit: function (payload) {
      parent.postMessage({ type: 'card:submit', cardId: CARD_ID, payload: payload }, '*');
    }
  };
})();`

/** 组装注入 cardId 后的桥脚本（占位符带引号，替换值经 JSON.stringify 转义） */
export function buildCardBridgeScript(cardId: string): string {
  return CARD_BRIDGE_SCRIPT.split(CARD_ID_PLACEHOLDER).join(JSON.stringify(cardId))
}
