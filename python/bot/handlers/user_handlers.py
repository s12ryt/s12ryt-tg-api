"""
User handlers - Regular user commands for the Telegram Bot.

Commands: /start, /url, /key (menu: view/add/del), /usage,
          /coding (menu: toggle/config), /model_catch
"""
import logging

from telegram import Update
from telegram.ext import ContextTypes, ConversationHandler

from config import Config
from db import database
from db.database import (
    get_coding_config_by_tg_id,
    set_coding_config,
)
from bot.handlers.model_fetcher import (
    fetch_models_no_auth,
    fetch_provider_models,
)
from bot.handlers.admin_handlers import _safe_reply_models

logger = logging.getLogger(__name__)


# ============================================================
# Conversation states
# ============================================================

# /key menu states
KEY_MENU = 0
KEY_DEL_SELECT = 1

# /coding menu states
CODING_MENU = 10
CODING_SET_FALLBACK = 11
CODING_SET_MAX_RETRIES = 12

# /model_catch states
MODEL_CATCH_URL = 20
MODEL_CATCH_KEY = 21

# Menu text constants
_KEY_MENU_TEXT = (
    "🔑 API Key 管理\n\n"
    "1. 查看 Key\n"
    "2. 新增 Key\n"
    "3. 刪除 Key\n\n"
    "請輸入數字選擇操作，或 /cancel 取消："
)

_CODING_MENU_TEXT = (
    "💻 Coding 模式管理\n\n"
    "1. 開關 Coding 模式\n"
    "2. 設定 Coding 模式（Fallback 模型鏈）\n\n"
    "請輸入數字選擇操作，或 /cancel 取消："
)


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


async def _ensure_user(update: Update) -> dict | None:
    """Ensure user exists in DB, return user dict or None."""
    tg_user_id = update.effective_user.id
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        username = update.effective_user.username or ""
        await database.add_user(tg_user_id, username)
        user = await database.get_user_by_tg_id(tg_user_id)
    return user


async def key_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Entry point for /key menu."""
    await _ensure_user(update)
    await update.message.reply_text(_KEY_MENU_TEXT)
    return KEY_MENU


async def key_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Route /key menu selection."""
    text = update.message.text.strip()
    if text == "1":
        return await _key_view(update, context)
    elif text == "2":
        return await _key_add(update, context)
    elif text == "3":
        return await _key_del_list(update, context)
    else:
        await update.message.reply_text("❌ 無效選項，請輸入 1-3：")
        return KEY_MENU


async def _key_view(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Show existing keys, then return to menu."""
    tg_user_id = update.effective_user.id
    keys = await database.get_keys_by_user(tg_user_id)
    active_keys = [k for k in keys if k.get("is_active")]

    if not active_keys:
        # Auto-create first key
        result = await database.add_api_key(tg_user_id)
        if result:
            await update.message.reply_text(f"✅ 已自動建立 key：`{result['key']}`\n\n" + _KEY_MENU_TEXT, parse_mode="Markdown")
        else:
            await update.message.reply_text("❌ 創建 key 失敗。\n\n" + _KEY_MENU_TEXT)
    else:
        key_list = "\n".join(f"  `{k['key']}`" for k in active_keys)
        await update.message.reply_text(f"您的 key：\n{key_list}\n\n" + _KEY_MENU_TEXT, parse_mode="Markdown")
    return KEY_MENU


async def _key_add(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Add a new key, then return to menu."""
    tg_user_id = update.effective_user.id
    await _ensure_user(update)
    result = await database.add_api_key(tg_user_id)
    if result:
        await update.message.reply_text(f"✅ 新增 key：`{result['key']}`\n\n" + _KEY_MENU_TEXT, parse_mode="Markdown")
    else:
        await update.message.reply_text("❌ 創建 key 失敗。\n\n" + _KEY_MENU_TEXT)
    return KEY_MENU


async def _key_del_list(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """List keys for deletion multi-select."""
    tg_user_id = update.effective_user.id
    keys = await database.get_keys_by_user(tg_user_id)
    active_keys = [k for k in keys if k.get("is_active")]

    if not active_keys:
        await update.message.reply_text("您沒有可刪除的 API key。\n\n" + _KEY_MENU_TEXT)
        return KEY_MENU

    context.user_data["key_del_map"] = {str(i + 1): k["id"] for i, k in enumerate(active_keys)}
    lines = [f"{i}. `{k['key']}`" for i, k in enumerate(active_keys, 1)]
    await update.message.reply_text(
        "請回覆要刪除的 key 編號（多選用逗號分隔，如: 1,2）：\n\n" + "\n".join(lines) + "\n\n或輸入 0 返回選單：",
        parse_mode="Markdown",
    )
    return KEY_DEL_SELECT


async def key_del_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle key deletion selection."""
    text = update.message.text.strip()
    keys_map: dict = context.user_data.get("key_del_map", {})

    if text == "0":
        context.user_data.pop("key_del_map", None)
        await update.message.reply_text(_KEY_MENU_TEXT)
        return KEY_MENU

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤，請使用數字編號（如: 1,2）：")
        return KEY_DEL_SELECT

    selected = set()
    for idx in indices:
        if idx in keys_map:
            selected.add(idx)

    if not selected:
        await update.message.reply_text("❌ 未選中任何有效編號，請重新輸入：")
        return KEY_DEL_SELECT

    deleted = 0
    for idx in selected:
        key_id = keys_map.get(idx)
        if key_id:
            success = await database.delete_api_key(key_id)
            if success:
                deleted += 1

    context.user_data.pop("key_del_map", None)
    await update.message.reply_text(f"✅ 已刪除 {deleted} 個 API key。\n\n" + _KEY_MENU_TEXT)
    return KEY_MENU


async def key_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel /key conversation."""
    context.user_data.pop("key_del_map", None)
    await update.message.reply_text("❌ 已取消。")
    return ConversationHandler.END


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


# ============================================================
# /coding - Unified coding mode menu (toggle + config)
# ============================================================

async def coding_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Entry point for /coding menu."""
    tg_user_id = update.effective_user.id
    user = await database.get_user_by_tg_id(tg_user_id)
    if not user:
        await update.message.reply_text("❌ 您尚未註冊，請先使用 /key 創建 API key。")
        return ConversationHandler.END
    await update.message.reply_text(_CODING_MENU_TEXT)
    return CODING_MENU


async def coding_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Route /coding menu selection."""
    text = update.message.text.strip()
    if text == "1":
        return await _coding_toggle(update, context)
    elif text == "2":
        return await _coding_config_start(update, context)
    else:
        await update.message.reply_text("❌ 無效選項，請輸入 1 或 2：")
        return CODING_MENU


async def _coding_toggle(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Toggle coding mode on/off, then return to menu."""
    from db.database import reset_coding_session_stats
    tg_user_id = update.effective_user.id
    user = await database.get_user_by_tg_id(tg_user_id)

    config = await get_coding_config_by_tg_id(tg_user_id)

    if config and config.get("is_active"):
        # Deactivate + show session summary
        s_in = config.get("session_input_tokens", 0) or 0
        s_out = config.get("session_output_tokens", 0) or 0
        s_in_cost = config.get("session_input_cost", 0.0) or 0.0
        s_out_cost = config.get("session_output_cost", 0.0) or 0.0
        s_reqs = config.get("session_requests", 0) or 0

        await set_coding_config(user["id"], is_active=0)

        if s_reqs > 0:
            import json
            total_cost = s_in_cost + s_out_cost
            model_counts_raw = config.get("session_model_counts", "{}") or "{}"
            try:
                model_counts = json.loads(model_counts_raw) if isinstance(model_counts_raw, str) else {}
            except (json.JSONDecodeError, TypeError):
                model_counts = {}
            model_breakdown = ""
            if model_counts:
                model_breakdown = "\n\n📋 模型調用統計：\n" + "\n".join(
                    f"   {m}: {c} 次" for m, c in model_counts.items()
                )
            await update.message.reply_text(
                f"🔴 Coding 模式已關閉。\n\n"
                f"📊 本次 Coding Session 統計：\n"
                f"   調用次數：{s_reqs}\n"
                f"   輸入 Token：{s_in:,}\n"
                f"   輸出 Token：{s_out:,}\n"
                f"   輸入費用：${s_in_cost:.6f}\n"
                f"   輸出費用：${s_out_cost:.6f}\n"
                f"   總費用：${total_cost:.6f}"
                + model_breakdown
                + "\n\n" + _CODING_MENU_TEXT
            )
        else:
            await update.message.reply_text("🔴 Coding 模式已關閉。\n\n📊 本次 Session 無請求記錄。\n\n" + _CODING_MENU_TEXT)
    else:
        # Activate + reset session stats
        if config and config.get("fallback_models"):
            await set_coding_config(user["id"], is_active=1)
            await reset_coding_session_stats(user["id"])
            fallback_list = [m.strip() for m in config["fallback_models"].split(",") if m.strip()]
            await update.message.reply_text(
                f"🟢 Coding 模式已開啟！\n\n"
                f"📋 當前 Fallback 模型鏈：\n"
                + "\n".join(f"   {i + 1}. {m}" for i, m in enumerate(fallback_list))
                + f"\n\n最大重試次數：{config.get('max_retries', 3)}"
                + "\n\n" + _CODING_MENU_TEXT
            )
        else:
            await set_coding_config(user["id"], is_active=1)
            await update.message.reply_text(
                "🟢 Coding 模式已開啟，但尚未設定 Fallback 模型。\n"
                "請選擇 2 設定 Fallback 模型鏈。\n\n" + _CODING_MENU_TEXT
            )
    return CODING_MENU


async def _coding_config_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start coding config — show current config or available models."""
    tg_user_id = update.effective_user.id

    config = await get_coding_config_by_tg_id(tg_user_id)
    if config and config.get("fallback_models"):
        current = config["fallback_models"]
        await update.message.reply_text(
            f"📋 當前 Coding 模式設定：\n"
            f"   Fallback 模型：{current}\n"
            f"   最大重試次數：{config.get('max_retries', 3)}\n"
            f"   狀態：{'🟢 開啟' if config.get('is_active') else '🔴 關閉'}\n\n"
            "請輸入新的 Fallback 模型鏈（用逗號分隔，按順序排列）：\n"
            "例如：claude-4-sonnet,gpt-4o,deepseek-v3\n\n"
            "或輸入 skip 保持不變："
        )
    else:
        from db.database import get_provider_cache
        cache = get_provider_cache()
        available = sorted(cache.keys())
        model_list = "\n".join(f"   {m}" for m in available[:30])
        suffix = f"\n   ...還有 {len(available) - 30} 個" if len(available) > 30 else ""
        await update.message.reply_text(
            "🔧 設定 Coding 模式 — Fallback 模型鏈\n\n"
            "當主模型報錯時，會按順序嘗試以下模型：\n\n"
            f"📦 可用模型：\n{model_list}{suffix}\n\n"
            "請輸入 Fallback 模型鏈（用逗號分隔，按優先順序排列）：\n"
            "例如：claude-4-sonnet,gpt-4o,deepseek-v3"
        )
    return CODING_SET_FALLBACK


async def coding_set_fallback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive fallback model chain."""
    text = update.message.text.strip().lower()

    if text == "skip":
        await update.message.reply_text("請輸入最大重試次數（1-10），或輸入 skip 保持預設（3）：")
        return CODING_SET_MAX_RETRIES

    from db.database import get_provider_cache
    cache = get_provider_cache()
    models = [m.strip() for m in text.split(",") if m.strip()]

    invalid = [m for m in models if m not in cache]
    if invalid:
        await update.message.reply_text(
            f"❌ 以下模型不存在：{', '.join(invalid)}\n\n"
            "請重新輸入，或輸入 skip 保持不變："
        )
        return CODING_SET_FALLBACK

    context.user_data["coding_fallback_models"] = ",".join(models)

    await update.message.reply_text(
        f"✅ Fallback 模型鏈：\n"
        + "\n".join(f"   {i + 1}. {m}" for i, m in enumerate(models))
        + "\n\n請輸入最大重試次數（1-10），或輸入 skip 保持預設（3）："
    )
    return CODING_SET_MAX_RETRIES


async def coding_set_max_retries(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive max retries and save config, then return to menu."""
    text = update.message.text.strip().lower()
    tg_user_id = update.effective_user.id
    user = await database.get_user_by_tg_id(tg_user_id)

    if text == "skip":
        max_retries = 3
    else:
        try:
            max_retries = int(text)
            if not 1 <= max_retries <= 10:
                await update.message.reply_text("❌ 請輸入 1-10 之間的數字：")
                return CODING_SET_MAX_RETRIES
        except ValueError:
            await update.message.reply_text("❌ 請輸入數字（1-10）：")
            return CODING_SET_MAX_RETRIES

    fallback_models = context.user_data.pop("coding_fallback_models", None)

    current_config = await get_coding_config_by_tg_id(tg_user_id)
    if fallback_models is None:
        fallback_models = current_config.get("fallback_models", "") if current_config else ""

    await set_coding_config(
        user["id"],
        is_active=1,
        fallback_models=fallback_models,
        max_retries=max_retries,
    )

    fallback_list = [m.strip() for m in fallback_models.split(",") if m.strip()]
    await update.message.reply_text(
        "✅ Coding 模式設定完成！\n\n"
        f"📋 Fallback 模型鏈：\n"
        + "\n".join(f"   {i + 1}. {m}" for i, m in enumerate(fallback_list))
        + f"\n\n最大重試次數：{max_retries}\n"
        "狀態：🟢 已開啟\n\n"
        + _CODING_MENU_TEXT
    )
    return CODING_MENU


async def coding_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel /coding conversation."""
    context.user_data.pop("coding_fallback_models", None)
    await update.message.reply_text("❌ 已取消。")
    return ConversationHandler.END


# ============================================================
# /model_catch - Fetch model list from an external API URL
# ============================================================


async def model_catch_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /model_catch conversation — ask for URL."""
    await update.message.reply_text(
        "🔍 請輸入要抓取模型的 API URL：\n\n"
        "例如：https://api.example.com/v1"
    )
    return MODEL_CATCH_URL


async def model_catch_url(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive URL and try fetching models without auth."""
    url = update.message.text.strip()
    context.user_data["model_catch_url"] = url

    await update.message.reply_text("⏳ 正在嘗試抓取模型列表（不帶 Key）...")

    models, needs_auth = await fetch_models_no_auth(url)

    if needs_auth:
        await update.message.reply_text(
            "🔒 伺服器要求認證（401/403）。\n"
            "請輸入 API Key，或輸入 /cancel 取消："
        )
        return MODEL_CATCH_KEY

    if not models:
        await update.message.reply_text(
            "❌ 無法從該 URL 獲取模型列表。\n"
            "可能原因：URL 不正確、伺服器無回應、或回應格式不支援。\n\n"
            "請確認 URL 格式後重新嘗試。"
        )
        return ConversationHandler.END

    # Display models (with safe pagination)
    await _safe_reply_models(update, models, header=f"✅ 找到 {len(models)} 個模型：")
    context.user_data.pop("model_catch_url", None)
    return ConversationHandler.END


async def model_catch_key(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive API key and retry fetching models."""
    api_key = update.message.text.strip()
    url = context.user_data.get("model_catch_url", "")

    await update.message.reply_text("⏳ 正在使用 Key 重新抓取模型列表...")

    # Try with openai_chat format (most common)
    models = await fetch_provider_models(url, api_key, "openai_chat")

    if not models:
        # Try google format as fallback
        models = await fetch_provider_models(url, api_key, "google")

    if not models:
        await update.message.reply_text(
            "❌ 即使使用 Key 也無法獲取模型列表。\n"
            "請確認 URL 和 Key 是否正確。"
        )
        context.user_data.pop("model_catch_url", None)
        return ConversationHandler.END

    # Display models (with safe pagination)
    await _safe_reply_models(update, models, header=f"✅ 找到 {len(models)} 個模型：")
    context.user_data.pop("model_catch_url", None)
    return ConversationHandler.END


async def model_catch_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel /model_catch conversation."""
    context.user_data.pop("model_catch_url", None)
    await update.message.reply_text("❌ 已取消。")
    return ConversationHandler.END


def register_user_handlers(app):
    """Register all user command handlers."""
    from telegram.ext import CommandHandler, MessageHandler, filters, ConversationHandler
    from bot.filters import trusted_user_filter

    _filt = filters.Async(trusted_user_filter.filter_async)

    # Simple commands
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("url", url_command, filters=_filt))
    app.add_handler(CommandHandler("usage", usage_command, filters=_filt))

    # /key — unified key management menu (view / add / del)
    key_conv = ConversationHandler(
        entry_points=[CommandHandler("key", key_start, filters=_filt)],
        states={
            KEY_MENU: [MessageHandler(filters.TEXT & ~filters.COMMAND, key_menu)],
            KEY_DEL_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, key_del_select)],
        },
        fallbacks=[CommandHandler("cancel", key_cancel)],
    )
    app.add_handler(key_conv)

    # /coding — unified coding mode menu (toggle / config)
    coding_conv = ConversationHandler(
        entry_points=[CommandHandler("coding", coding_start, filters=_filt)],
        states={
            CODING_MENU: [MessageHandler(filters.TEXT & ~filters.COMMAND, coding_menu)],
            CODING_SET_FALLBACK: [MessageHandler(filters.TEXT & ~filters.COMMAND, coding_set_fallback)],
            CODING_SET_MAX_RETRIES: [MessageHandler(filters.TEXT & ~filters.COMMAND, coding_set_max_retries)],
        },
        fallbacks=[CommandHandler("cancel", coding_cancel)],
    )
    app.add_handler(coding_conv)

    # /model_catch needs conversation (URL → optional key)
    model_catch_conv = ConversationHandler(
        entry_points=[CommandHandler("model_catch", model_catch_start, filters=_filt)],
        states={
            MODEL_CATCH_URL: [MessageHandler(filters.TEXT & ~filters.COMMAND, model_catch_url)],
            MODEL_CATCH_KEY: [MessageHandler(filters.TEXT & ~filters.COMMAND, model_catch_key)],
        },
        fallbacks=[CommandHandler("cancel", model_catch_cancel)],
    )
    app.add_handler(model_catch_conv)
