import { InlineKeyboard } from "grammy";

/**
 * 建立帶有編號列表的 Inline Keyboard，用於多選操作
 * @param items - 要顯示的項目列表（每項含 id 與顯示文字）
 * @param prefix - callback data 的前綴，例如 "keydel"
 * @returns InlineKeyboard
 *
 * 排列方式：每行一個按鈕
 * 例如：
 *  1. sk-s12ryt-xxx...  →  callback: "prefix:0"
 *  2. sk-s12ryt-yyy...  →  callback: "prefix:1"
 */
export function buildNumberedListKeyboard(
  items: { id: number; label: string }[],
  prefix: string
): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (let i = 0; i < items.length; i++) {
    kb.text(`${i + 1}. ${items[i].label}`, `${prefix}:${items[i].id}`);
    if (i < items.length - 1) {
      kb.row();
    }
  }

  return kb;
}
