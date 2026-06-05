"""
Keyboards for the Telegram Bot.
Inline keyboards for multi-select and single-select operations.
"""
from telegram import InlineKeyboardButton, InlineKeyboardMarkup


def make_numbered_list_keyboard(
    items: list[dict],
    label_key: str = "name",
    extra_key: str | None = None,
    callback_prefix: str = "sel",
    multi_select: bool = True,
) -> InlineKeyboardMarkup:
    """Create an inline keyboard with numbered items.

    Args:
        items: List of dicts with at least an 'id' and label_key field.
        label_key: Key to use for display text.
        extra_key: Optional extra field to show in parentheses.
        callback_prefix: Prefix for callback data.
        multi_select: If True, adds confirm button.

    Returns:
        InlineKeyboardMarkup with numbered buttons.
    """
    buttons = []
    for i, item in enumerate(items, 1):
        label = item.get(label_key, str(item.get("id", "")))
        if extra_key and item.get(extra_key):
            label = f"{label} ({item[extra_key]})"
        buttons.append([
            InlineKeyboardButton(
                f"{i}. {label}",
                callback_data=f"{callback_prefix}:{item['id']}",
            )
        ])

    if multi_select:
        buttons.append([
            InlineKeyboardButton("✅ 確認", callback_data=f"{callback_prefix}:confirm")
        ])
        buttons.append([
            InlineKeyboardButton("❌ 取消", callback_data=f"{callback_prefix}:cancel")
        ])
    else:
        buttons.append([
            InlineKeyboardButton("❌ 取消", callback_data=f"{callback_prefix}:cancel")
        ])

    return InlineKeyboardMarkup(buttons)


def make_cancel_keyboard() -> InlineKeyboardMarkup:
    """Simple cancel-only keyboard."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("❌ 取消", callback_data="cancel")]
    ])
