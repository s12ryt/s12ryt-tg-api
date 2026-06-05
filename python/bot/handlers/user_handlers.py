"""
User handlers - Regular user commands for the Telegram Bot.

Commands: /start, /url, /key, /usage, /key-add, /key-del
"""
import logging

from telegram import Update
from telegram.ext import ContextTypes

from config import Config
from db import database

logger = logging.getLogger(__name__)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start command."""
    await update.message.reply_text("你好!")


async def url_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /url command - Return current API endpoint."""
    # Check settings first, fall back to default
    url = await database.get_setting("api_url")
    if not url:
        url = Config.DEFAULT_API_URL
    await update.message.reply_text(f"當前 API 接口: {url}")


async def key_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /key command.
    If user has no key, create one. Otherwise return existing keys.
    """
    tg_user_id = update.effective_user.id

    # Ensure user exists in database
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        # Auto-create user on first /key
        username = update.effective_user.username or ""
        await database.add_user(tg_user_id, username)
        user = await database.get_user_by_tg_id(tg_user_id)

    # Get existing keys
    keys = await database.get_keys_by_user(tg_user_id)

    if not keys:
        # First time - create a new key
        result = await database.add_api_key(tg_user_id)
        if result:
            await update.message.reply_text(f"您的 key: {result['key']}")
        else:
            await update.message.reply_text("❌ 創建 key 失敗，請稍後再試。")
    else:
        # Show existing keys
        key_list = "\n".join(f"  `{k['key']}`" for k in keys if k.get("is_active"))
        if not key_list:
            # All keys inactive, create new one
            result = await database.add_api_key(tg_user_id)
            if result:
                await update.message.reply_text(f"您的 key: {result['key']}")
            else:
                await update.message.reply_text("❌ 創建 key 失敗，請稍後再試。")
        else:
            await update.message.reply_text(f"您的 key:\n{key_list}", parse_mode="Markdown")


async def usage_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /usage command - Show token usage for all user's API keys."""
    tg_user_id = update.effective_user.id
    keys = await database.get_keys_by_user(tg_user_id)

    if not keys:
        await update.message.reply_text("您還沒有任何 API key，請使用 /key 創建。")
        return

    lines = []
    for key_record in keys:
        if not key_record.get("is_active"):
            continue
        key_display = key_record["key"][:20] + "..."
        usage_records = await database.get_usage_by_key(key_record["id"])

        total_input = sum(r.get("input_tokens", 0) for r in usage_records)
        total_output = sum(r.get("output_tokens", 0) for r in usage_records)
        total_input_cost = sum(r.get("input_cost", 0) for r in usage_records)
        total_output_cost = sum(r.get("output_cost", 0) for r in usage_records)

        lines.append(
            f"🔑 `{key_display}`\n"
            f"  輸入 token: {total_input:,}\n"
            f"  輸出 token: {total_output:,}\n"
            f"  輸入費用: ${total_input_cost:.6f}\n"
            f"  輸出費用: ${total_output_cost:.6f}"
        )

    if not lines:
        await update.message.reply_text("暫無使用記錄。")
    else:
        await update.message.reply_text("\n\n".join(lines), parse_mode="Markdown")


async def key_add_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /key-add command - Add a new API key."""
    tg_user_id = update.effective_user.id

    # Ensure user exists
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        username = update.effective_user.username or ""
        await database.add_user(tg_user_id, username)

    result = await database.add_api_key(tg_user_id)
    if result:
        await update.message.reply_text(f"您的 key: {result['key']}")
    else:
        await update.message.reply_text("❌ 創建 key 失敗，請稍後再試。")


async def key_del_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /key-del command - List keys for multi-select deletion."""
    tg_user_id = update.effective_user.id
    keys = await database.get_keys_by_user(tg_user_id)

    active_keys = [k for k in keys if k.get("is_active")]
    if not active_keys:
        await update.message.reply_text("您沒有可刪除的 API key。")
        return

    # Store keys in user_data for later callback processing
    context.user_data["keys_to_delete"] = {str(i + 1): k["id"] for i, k in enumerate(active_keys)}
    context.user_data["selected_for_deletion"] = set()

    # Build numbered list
    lines = []
    for i, k in enumerate(active_keys, 1):
        lines.append(f"{i}. `{k['key']}`")

    await update.message.reply_text(
        "請回覆要刪除的 key 編號（多選用逗號分隔，如: 1,2）：\n\n" + "\n".join(lines),
        parse_mode="Markdown",
    )

    # Set state for text reply handling
    return "WAITING_KEY_DEL"


async def key_del_text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle text reply for /key-del multi-select."""
    text = update.message.text.strip()
    keys_map: dict = context.user_data.get("keys_to_delete", {})
    selected: set = context.user_data.get("selected_for_deletion", set())

    # Parse selection
    try:
        indices = [idx.strip() for idx in text.split(",")]
        for idx in indices:
            if idx in keys_map:
                selected.add(idx)
    except Exception:
        await update.message.reply_text("❌ 格式錯誤，請使用數字編號（如: 1,2）。")
        return "WAITING_KEY_DEL"

    # Delete selected keys
    deleted = 0
    for idx in selected:
        key_id = keys_map.get(idx)
        if key_id:
            success = await database.delete_api_key(key_id)
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個 API key。")

    # Clean up
    context.user_data.pop("keys_to_delete", None)
    context.user_data.pop("selected_for_deletion", None)
    return -1  # End conversation


def register_user_handlers(app):
    """Register all user command handlers."""
    from telegram.ext import CommandHandler, MessageHandler, filters, ConversationHandler
    from bot.filters import trusted_user_filter

    # Simple commands
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("url", url_command, filters=filters.Async(trusted_user_filter.filter_async)))
    app.add_handler(CommandHandler("key", key_command, filters=filters.Async(trusted_user_filter.filter_async)))
    app.add_handler(CommandHandler("usage", usage_command, filters=filters.Async(trusted_user_filter.filter_async)))
    app.add_handler(CommandHandler("key_add", key_add_command, filters=filters.Async(trusted_user_filter.filter_async)))

    # /key-del needs conversation
    key_del_conv = ConversationHandler(
        entry_points=[CommandHandler("key_del", key_del_command, filters=filters.Async(trusted_user_filter.filter_async))],
        states={
            "WAITING_KEY_DEL": [MessageHandler(filters.TEXT & ~filters.COMMAND, key_del_text_handler)],
        },
        fallbacks=[CommandHandler("cancel", lambda u, c: -1)],
    )
    app.add_handler(key_del_conv)
