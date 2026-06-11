"""
Admin handlers - Admin-only commands for the Telegram Bot.

Commands: /provider, /list, /uu, /admin_user, /sub_url, /api_test
"""
import logging
from typing import Any

from telegram import Update
from telegram.ext import ContextTypes, ConversationHandler

from config import Config
from db import database
from bot.keyboards import make_numbered_list_keyboard
from bot.handlers.model_fetcher import fetch_provider_models, fetch_models_pricing, detect_api_protocols, detect_protocols_no_auth

logger = logging.getLogger(__name__)

# Telegram message character limit (leave margin for formatting)
_MAX_MSG_LEN = 3800


async def _safe_reply_models(
    update: Update,
    models: list[dict],
    *,
    header: str = "",
    footer: str = "",
) -> None:
    """Reply with a model list, splitting into multiple messages if needed.

    Each model is shown as ``{n}. {model_id}``.
    Messages are split at ~3800 chars to stay under Telegram's 4096 limit.
    """
    if not models:
        await update.message.reply_text(header or "（無模型）")
        return

    lines: list[str] = []
    for i, m in enumerate(models, 1):
        lines.append(f"{i}. {m.get('id', m.get('name', '?'))}")

    # Batch lines into chunks that fit within _MAX_MSG_LEN
    chunks: list[str] = []
    current_lines: list[str] = []
    current_len = len(header) + 2 if header else 0

    for line in lines:
        added = len(line) + 1  # +1 for newline
        if current_len + added > _MAX_MSG_LEN and current_lines:
            chunks.append("\n".join(current_lines))
            current_lines = []
            current_len = 0
        current_lines.append(line)
        current_len += added

    if current_lines:
        chunks.append("\n".join(current_lines))

    # Send chunks
    for idx, chunk in enumerate(chunks):
        parts: list[str] = []
        if idx == 0 and header:
            parts.append(header)
        parts.append(chunk)
        if idx == len(chunks) - 1 and footer:
            parts.append(footer)
        await update.message.reply_text("\n\n".join(parts))


def _build_model_selection_prompt(
    total: int,
    *,
    is_search: bool = False,
    search_keyword: str = "",
    shown: int | None = None,
) -> str:
    """Build the prompt text shown after a model list."""
    if is_search:
        header = f'🔍 搜尋 "{search_keyword}" 找到 {total} 個模型：'
    else:
        header = f"✅ 獲取到 {total} 個模型："

    if shown is not None and shown < total:
        header += f"（顯示前 {shown} 個）"

    footer = (
        "\n\n請選擇：\n"
        "• 輸入編號（多選用逗號分隔）\n"
        '• 輸入 "all" 全選\n'
        '• 輸入 "manual" 手動輸入\n'
        "• 輸入關鍵字搜尋模型（例如：gpt）"
    )
    if is_search:
        footer += '\n• 輸入 "back" 返回完整列表'

    return header, footer


def _filter_models(models: list[dict], keyword: str) -> list[dict]:
    """Filter models by keyword (case-insensitive substring match)."""
    kw = keyword.lower()
    return [m for m in models if kw in m.get("id", "").lower() or kw in m.get("name", "").lower()]


# Conversation states
(
    ADD_PROVIDER_NAME,
    ADD_PROVIDER_TYPE,
    ADD_PROVIDER_URL,
    ADD_PROVIDER_KEY,
    ADD_PROVIDER_MODELS_SELECT,
    ADD_PROVIDER_MODELS_MANUAL,
    ADD_PROVIDER_PRICE_CONFIRM,
    ADD_PROVIDER_PRICE_MANUAL,
    ADD_PROVIDER_PRICE_PER_MODEL,
    EDIT_PROVIDER_SELECT,
    EDIT_PROVIDER_FIELD,
    EDIT_PROVIDER_VALUE,
    EDIT_PROVIDER_MODELS_SELECT,
    EDIT_PROVIDER_MODELS_MANUAL,
    EDIT_PROVIDER_MODELS_PRICE_CONFIRM,
    EDIT_PROVIDER_PRICE_MODELSDEV,
    EDIT_PROVIDER_PRICE_MANUAL,
    EDIT_PROVIDER_PRICE_PER_MODEL,
    SUB_URL_INPUT,
) = range(17)

# /api_test conversation states (separate from main range)
API_TEST_URL = 100
API_TEST_KEY = 101

# /admin_user conversation states (separate unified menu)
ADMIN_USER_MENU = 200
ADMIN_USER_ADD_INPUT = 201
ADMIN_USER_STOP_SELECT = 202
ADMIN_USER_DEL_SELECT = 203
ADMIN_USER_EDIT_SELECT = 204
ADMIN_USER_EDIT_INPUT = 205
ADMIN_USER_RM_KEY_SELECT = 206

# /provider conversation states (separate unified menu)
PROVIDER_MENU = 300
PROVIDER_DEL_SELECT = 301


_PROVIDER_MENU_TEXT = (
    "🔧 供應商管理\n\n"
    "請選擇操作：\n"
    "1. 新增供應商\n"
    "2. 刪除供應商\n"
    "3. 列表\n"
    "4. 編輯供應商\n\n"
    "輸入 /cancel 取消"
)


def _provider_end(context: ContextTypes.DEFAULT_TYPE) -> int:
    """Return PROVIDER_MENU if came from /provider menu, else END."""
    if context.user_data.pop("from_provider_menu", None):
        return PROVIDER_MENU
    return ConversationHandler.END


async def _provider_show_list(update: Update) -> None:
    """Show provider list (reuses list_command logic)."""
    from db.database import get_model_prices_by_provider
    providers = await database.get_providers()
    if not providers:
        await update.message.reply_text("目前沒有任何提供商。")
        return

    lines = []
    for p in providers:
        usage_records = await database.get_usage_by_provider(p["id"])
        total_input = sum(r.get("input_tokens", 0) for r in usage_records)
        total_output = sum(r.get("output_tokens", 0) for r in usage_records)
        total_input_cost = sum(r.get("input_cost", 0) for r in usage_records)
        total_output_cost = sum(r.get("output_cost", 0) for r in usage_records)
        status = "✅" if p.get("enabled") else "❌"

        model_prices = await get_model_prices_by_provider(p["id"])
        price_lines = "\n".join(
            f"    {mp['model']}：輸入 ${mp.get('input_price') or '—'} / 輸出 ${mp.get('output_price') or '—'}"
            for mp in model_prices
        ) if model_prices else "    （無模型定價）"

        lines.append(
            f"{status} {p['name']} ({p['api_type']})\n"
            f"  模型：{p.get('models', '(無)')}\n"
            f"  模型定價（每 1M tokens）：\n{price_lines}\n"
            f"  輸入 token: {total_input:,} / 輸出 token: {total_output:,}\n"
            f"  輸入費用: ${total_input_cost:.6f} / 輸出費用: ${total_output_cost:.6f}"
        )

    await update.message.reply_text("\n\n".join(lines))


# ============================================================
# /provider - Unified provider management menu
# ============================================================

async def provider_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /provider menu."""
    await update.message.reply_text(_PROVIDER_MENU_TEXT)
    return PROVIDER_MENU


async def provider_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Route provider menu selection."""
    text = update.message.text.strip()

    if text == "1":
        # 新增供應商 — 進入 add 流程
        context.user_data["from_provider_menu"] = True
        return await add_start(update, context)
    elif text == "2":
        # 刪除供應商 — 列出供應商
        providers = await database.get_providers()
        if not providers:
            await update.message.reply_text("目前沒有任何提供商。\n\n" + _PROVIDER_MENU_TEXT)
            return PROVIDER_MENU

        context.user_data["providers_map"] = {str(i + 1): p["id"] for i, p in enumerate(providers)}
        lines = [f"{i + 1}. {p['name']} ({p['api_type']})" for i, p in enumerate(providers)]
        await update.message.reply_text(
            "請回覆要刪除的提供商編號（多選用逗號分隔，如: 1,2）：\n\n" + "\n".join(lines)
        )
        return PROVIDER_DEL_SELECT
    elif text == "3":
        # 列表
        await _provider_show_list(update)
        await update.message.reply_text(_PROVIDER_MENU_TEXT)
        return PROVIDER_MENU
    elif text == "4":
        # 編輯供應商 — 進入 edit 流程
        context.user_data["from_provider_menu"] = True
        return await edit_start(update, context)
    else:
        await update.message.reply_text("❌ 請輸入 1-4 選擇操作。\n\n" + _PROVIDER_MENU_TEXT)
        return PROVIDER_MENU


async def provider_del_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process deletion from provider menu."""
    text = update.message.text.strip()
    providers_map: dict = context.user_data.get("providers_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。\n\n" + _PROVIDER_MENU_TEXT)
        context.user_data.pop("providers_map", None)
        return PROVIDER_MENU

    deleted = 0
    for idx in indices:
        provider_id = providers_map.get(idx)
        if provider_id:
            success = await database.delete_provider(provider_id)
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個提供商。\n\n" + _PROVIDER_MENU_TEXT)
    context.user_data.pop("providers_map", None)
    return PROVIDER_MENU


async def provider_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel provider menu."""
    await update.message.reply_text("❌ 操作已取消。")
    context.user_data.pop("from_provider_menu", None)
    context.user_data.pop("providers_map", None)
    context.user_data.pop("new_provider", None)
    context.user_data.pop("model_pricing_entries", None)
    context.user_data.pop("editing_provider", None)
    context.user_data.pop("edit_field", None)
    context.user_data.pop("model_pricing_entries", None)
    return ConversationHandler.END


# ============================================================
# /add - Multi-turn conversation to add a new AI provider
# ============================================================

async def add_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start the /add conversation."""
    await update.message.reply_text(
        "📝 新增 AI 提供商\n\n"
        "請輸入提供商名稱（用於顯示，如: OpenAI-Main）："
    )
    return ADD_PROVIDER_NAME


async def add_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive provider name, then ask for base URL."""
    context.user_data["new_provider"] = {"name": update.message.text.strip()}
    await update.message.reply_text("請輸入 API Base URL（如: https://api.openai.com/v1）：")
    return ADD_PROVIDER_URL


async def add_url(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive provider base URL, then ask for API key."""
    context.user_data["new_provider"]["base_url"] = update.message.text.strip()
    await update.message.reply_text("請輸入 API Key（可使用 , 分隔多個 API Key）：")
    return ADD_PROVIDER_KEY


async def add_key(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive provider API key(s), auto-detect protocols, then ask user to select type."""
    import json
    from api.key_selector import get_first_key

    # Parse comma-separated keys → JSON array
    raw_input = update.message.text.strip()
    keys = [k.strip() for k in raw_input.split(",") if k.strip()]
    api_key_json = json.dumps(keys)
    context.user_data["new_provider"]["api_key"] = api_key_json

    # Use first key for detection and model fetching
    first_key = keys[0]
    provider = context.user_data["new_provider"]

    # Auto-detect supported API protocols (v2: precise status code analysis)
    await update.message.reply_text("🔍 正在偵測 API 端點支持的協議...")
    detection = await detect_api_protocols(provider["base_url"], first_key)
    protocols = detection["protocols"]
    recommended = detection["recommended"]

    # Build display with confidence levels and reasons
    protocol_labels = {
        "openai_chat": "OpenAI (Chat Completions)",
        "openai_response": "OpenAI (Responses API)",
        "anthropic": "Anthropic (Messages)",
        "google": "Google (Gemini)",
    }
    type_map = {"1": "openai_chat", "2": "openai_response", "3": "anthropic", "4": "google"}

    _conf_icon = {"high": "✅", "medium": "⚠️", "low": "❓"}

    any_supported = any(d["supported"] for d in protocols.values())
    lines = []
    for i, (key, label) in enumerate(protocol_labels.items(), 1):
        detail = protocols.get(key, {"supported": False, "confidence": "low", "reason": ""})
        if detail["supported"]:
            icon = _conf_icon.get(detail["confidence"], "❓")
            lines.append(f"{i}. {label} — {icon} {detail['reason']}")
        else:
            lines.append(f"{i}. {label} — ❌ {detail['reason']}")

    header = "📡 API 端點偵測結果：\n\n"
    body = "\n".join(lines)

    # Show recommendation if available
    rec_line = ""
    if recommended:
        rec_label = protocol_labels.get(recommended, recommended)
        rec_line = f"\n\n💡 建議選擇：{rec_label}"

    if any_supported:
        await update.message.reply_text(
            header + body + rec_line + "\n\n請選擇 API 類型（輸入數字或名稱）："
        )
    else:
        await update.message.reply_text(
            header + body
            + "\n\n⚠️ 所有協議都不支援，請手動確認後選擇類型："
        )

    context.user_data["detected_protocols"] = detection
    return ADD_PROVIDER_TYPE


async def add_type(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive provider API type, then auto-fetch models."""
    text = update.message.text.strip().lower()
    type_map = {"1": "openai_chat", "2": "openai_response", "3": "anthropic", "4": "google"}
    api_type = type_map.get(text, text)

    if api_type not in ("openai_chat", "openai_response", "anthropic", "google"):
        await update.message.reply_text("❌ 無效的類型，請輸入 openai_chat/openai_response/anthropic/google 或 1/2/3/4：")
        return ADD_PROVIDER_TYPE

    context.user_data["new_provider"]["api_type"] = api_type

    # Auto-fetch models from provider
    provider = context.user_data["new_provider"]
    await update.message.reply_text("🔍 正在從提供商獲取模型列表...")
    from api.key_selector import get_first_key
    first_key = get_first_key(provider["api_key"])
    fetched = await fetch_provider_models(
        provider["base_url"], first_key, provider["api_type"]
    )

    if fetched:
        # Show list for user to select (with safe pagination)
        context.user_data["fetched_models"] = fetched

        header, footer = _build_model_selection_prompt(len(fetched))
        await _safe_reply_models(update, fetched, header=header, footer=footer)
        return ADD_PROVIDER_MODELS_SELECT
    else:
        await update.message.reply_text(
            "⚠️ 無法從提供商獲取模型列表。\n"
            "請手動輸入支持的模型列表（用逗號分隔，如: gpt-4o,gpt-4o-mini）："
        )
        return ADD_PROVIDER_MODELS_MANUAL


async def add_models_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process model selection from fetched list. Supports search keywords."""
    text = update.message.text.strip()
    text_lower = text.lower()
    all_fetched: list = context.user_data.get("fetched_models", [])

    # Check if we are in search mode
    search_results: list | None = context.user_data.get("search_results")

    if text_lower == "back":
        # Exit search mode, show full list again
        context.user_data.pop("search_results", None)
        header, footer = _build_model_selection_prompt(len(all_fetched))
        await _safe_reply_models(update, all_fetched, header=header, footer=footer)
        return ADD_PROVIDER_MODELS_SELECT

    if text_lower == "all":
        if search_results is not None:
            models = ",".join(m["id"] for m in search_results)
            context.user_data.pop("search_results", None)
        else:
            models = ",".join(m["id"] for m in all_fetched)
    elif text_lower == "manual":
        context.user_data.pop("search_results", None)
        await update.message.reply_text("請手動輸入模型（用逗號分隔）：")
        return ADD_PROVIDER_MODELS_MANUAL
    else:
        # Try to parse as number indices (from search results or full list)
        active_list = search_results if search_results is not None else all_fetched
        indices = []
        for part in text_lower.replace("，", ",").split(","):
            part = part.strip()
            if part.isdigit():
                n = int(part)
                if 1 <= n <= len(active_list):
                    indices.append(n)

        if indices:
            context.user_data.pop("search_results", None)
            indices = list(set(indices))
            models = ",".join(active_list[i - 1]["id"] for i in indices)
        else:
            # Treat as search keyword
            keyword = text.strip()
            filtered = _filter_models(all_fetched, keyword)
            if filtered:
                context.user_data["search_results"] = filtered
                header, footer = _build_model_selection_prompt(
                    len(filtered), is_search=True, search_keyword=keyword
                )
                await _safe_reply_models(update, filtered, header=header, footer=footer)
                return ADD_PROVIDER_MODELS_SELECT
            else:
                await update.message.reply_text(
                    f'🔍 搜尋 "{keyword}" 沒有找到任何模型。\n'
                    "請嘗試其他關鍵字，或輸入編號 / all / manual："
                )
                return ADD_PROVIDER_MODELS_SELECT

    context.user_data["new_provider"]["models"] = models
    context.user_data.pop("fetched_models", None)

    # Auto-fetch pricing
    return await _auto_fetch_pricing(update, context)


async def add_models_manual(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive manually entered models."""
    context.user_data["new_provider"]["models"] = update.message.text.strip()
    return await _auto_fetch_pricing(update, context)


async def _auto_fetch_pricing(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Try to auto-fetch per-model pricing from models.dev, then ask user."""
    provider = context.user_data["new_provider"]
    model_list = [m.strip() for m in provider.get("models", "").split(",") if m.strip()]

    if not model_list:
        await update.message.reply_text(
            '請輸入統一定價（格式: 輸入價格,輸出價格），或輸入 "skip" 跳過：'
        )
        return ADD_PROVIDER_PRICE_MANUAL

    await update.message.reply_text("🔍 正在從 models.dev 獲取每個模型的定價...")
    pricing_map = await fetch_models_pricing(model_list)

    # Build per-model pricing entries
    model_pricing_entries: list[dict] = []
    lines: list[str] = []
    has_any = False

    for model_id in model_list:
        p = pricing_map.get(model_id)
        if p and (p.get("input") is not None or p.get("output") is not None):
            model_pricing_entries.append({
                "model": model_id,
                "input_price": p.get("input"),
                "output_price": p.get("output"),
            })
            lines.append(f"   {model_id}：輸入 ${p.get('input') or '—'} / 輸出 ${p.get('output') or '—'}（每 1M tokens）")
            has_any = True
        else:
            model_pricing_entries.append({"model": model_id, "input_price": None, "output_price": None})
            lines.append(f"   {model_id}：未找到定價")

    context.user_data["model_pricing_entries"] = model_pricing_entries

    if has_any:
        await update.message.reply_text(
            f"📋 從 models.dev 獲取到以下定價（每 1M tokens）：\n\n" + "\n".join(lines) + "\n\n"
            "1️⃣ 使用 models.dev 的定價\n"
            "2️⃣ 為所有模型手動設定統一定價\n"
            "3️⃣ 逐個設定每個模型的定價\n"
            "4️⃣ 跳過\n\n"
            "請選擇 1/2/3/4："
        )
        return ADD_PROVIDER_PRICE_CONFIRM
    else:
        # No models.dev pricing found — enter per-model manual mode
        context.user_data["add_per_model_queue"] = model_list[:]
        context.user_data["add_per_model_entries"] = []
        first_model = model_list[0]
        await update.message.reply_text(
            "⚠️ 未從 models.dev 獲取到任何定價。\n\n"
            f"開始逐個設定模型定價。\n\n"
            f"📌 模型「{first_model}」\n"
            "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n"
            "或輸入 skip 跳過此模型："
        )
        return ADD_PROVIDER_PRICE_PER_MODEL


async def add_price_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process pricing confirmation choice."""
    text = update.message.text.strip()
    model_pricing_entries = context.user_data.get("model_pricing_entries", [])
    model_list = [m.strip() for m in context.user_data["new_provider"].get("models", "").split(",") if m.strip()]

    if text == "1":
        # Use fetched per-model pricing as-is
        pass
    elif text == "2":
        # Manual uniform pricing for all models
        await update.message.reply_text("請輸入統一定價（格式：輸入價格,輸出價格，每 1M tokens）：")
        context.user_data["model_pricing_entries"] = model_pricing_entries
        return ADD_PROVIDER_PRICE_MANUAL
    elif text == "3":
        # Per-model manual pricing — start iterating
        context.user_data["add_per_model_queue"] = model_list[:]
        context.user_data["add_per_model_entries"] = []
        first_model = model_list[0]
        await update.message.reply_text(
            f"📌 開始逐個設定模型定價。\n\n"
            f"模型「{first_model}」\n"
            "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n"
            "或輸入 skip 跳過此模型："
        )
        return ADD_PROVIDER_PRICE_PER_MODEL
    elif text == "4":
        # Skip — clear all pricing
        for entry in model_pricing_entries:
            entry["input_price"] = None
            entry["output_price"] = None
    else:
        await update.message.reply_text("❌ 無效的選擇，請輸入 1/2/3/4：")
        return ADD_PROVIDER_PRICE_CONFIRM

    return await _save_provider(update, context, model_pricing_entries)


async def add_price_manual(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive manual uniform pricing and save."""
    text = update.message.text.strip().lower()
    model_pricing_entries = context.user_data.get("model_pricing_entries", [])

    if text != "skip":
        try:
            parts = text.split(",")
            input_price = float(parts[0])
            output_price = float(parts[1]) if len(parts) > 1 else 0.0
            # Apply uniform pricing to all models
            for entry in model_pricing_entries:
                entry["input_price"] = input_price
                entry["output_price"] = output_price
        except (ValueError, IndexError):
            await update.message.reply_text("❌ 格式錯誤，請使用：輸入價格,輸出價格")
            return ADD_PROVIDER_PRICE_MANUAL

    return await _save_provider(update, context, model_pricing_entries)


async def add_price_per_model(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle per-model manual pricing iteration for /add flow."""
    text = update.message.text.strip()
    queue: list = context.user_data.get("add_per_model_queue", [])
    entries: list = context.user_data.get("add_per_model_entries", [])

    # Process current model's input
    current_model = queue.pop(0) if queue else None

    if current_model and text.lower() != "skip":
        try:
            parts = text.split(",")
            input_price = float(parts[0])
            output_price = float(parts[1]) if len(parts) > 1 else 0.0
            entries.append({
                "model": current_model,
                "input_price": input_price,
                "output_price": output_price,
            })
        except (ValueError, IndexError):
            # Put model back and re-ask
            queue.insert(0, current_model)
            await update.message.reply_text(
                f"❌ 格式錯誤。請輸入格式：輸入價格,輸出價格\n"
                f"或輸入 skip 跳過「{current_model}」："
            )
            return ADD_PROVIDER_PRICE_PER_MODEL

    # Ask for next model or finish
    if queue:
        next_model = queue[0]
        await update.message.reply_text(
            f"📌 模型「{next_model}」\n"
            "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n"
            "或輸入 skip 跳過此模型："
        )
        return ADD_PROVIDER_PRICE_PER_MODEL
    else:
        # All done — merge entries into model_pricing_entries and save
        model_pricing_entries = context.user_data.get("model_pricing_entries", [])
        entry_map = {e["model"]: e for e in entries}
        for mpe in model_pricing_entries:
            if mpe["model"] in entry_map:
                mpe["input_price"] = entry_map[mpe["model"]]["input_price"]
                mpe["output_price"] = entry_map[mpe["model"]]["output_price"]

        context.user_data.pop("add_per_model_queue", None)
        context.user_data.pop("add_per_model_entries", None)

        if entries:
            lines = "\n".join(
                f"   {e['model']}：${e['input_price']}/${e['output_price']}"
                for e in entries
            )
            await update.message.reply_text(
                f"✅ 已設定 {len(entries)} 個模型的定價：\n{lines}"
            )
        else:
            await update.message.reply_text("未設定任何定價。")

        return await _save_provider(update, context, model_pricing_entries)


async def _save_provider(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    model_pricing_entries: list[dict] | None = None,
) -> int:
    """Save the provider to the database with per-model pricing."""
    from db.database import batch_upsert_model_prices
    provider_data = context.user_data["new_provider"]

    # Save provider with null provider-level pricing
    result = await database.add_provider(
        name=provider_data["name"],
        api_type=provider_data["api_type"],
        base_url=provider_data["base_url"],
        api_key=provider_data["api_key"],
        models=provider_data.get("models", ""),
        input_price=None,
        output_price=None,
    )

    if result:
        # Save per-model pricing
        if model_pricing_entries:
            # Get the newly created provider's ID
            providers = await database.get_providers()
            new_provider = next((p for p in providers if p["name"] == provider_data["name"]), None)
            if new_provider:
                await batch_upsert_model_prices(new_provider["id"], model_pricing_entries)

        # Build summary
        pricing_summary = "\n   ".join(
            f"{e['model']}：${e.get('input_price')}/{e.get('output_price')}"
            for e in (model_pricing_entries or [])
            if e.get("input_price") is not None or e.get("output_price") is not None
        ) or "（無定價）"

        await update.message.reply_text(
            f"✅ 提供商 \"{provider_data['name']}\" 新增成功！\n"
            f"類型: {provider_data['api_type']}\n"
            f"模型: {provider_data.get('models', '')}\n"
            f"每模型定價（每 1M tokens）：\n   {pricing_summary}"
        )
    else:
        await update.message.reply_text("❌ 新增失敗，名稱可能已存在。")

    context.user_data.pop("new_provider", None)
    context.user_data.pop("model_pricing_entries", None)
    return _provider_end(context)



# (del_start/del_select removed — deletion now handled inside provider_menu + provider_del_select)


# ============================================================
# /list - List providers with usage
# ============================================================

async def list_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /list - list all providers with usage stats and per-model pricing."""
    from db.database import get_model_prices_by_provider
    providers = await database.get_providers()
    if not providers:
        await update.message.reply_text("目前沒有任何提供商。")
        return

    lines = []
    for p in providers:
        usage_records = await database.get_usage_by_provider(p["id"])
        total_input = sum(r.get("input_tokens", 0) for r in usage_records)
        total_output = sum(r.get("output_tokens", 0) for r in usage_records)
        total_input_cost = sum(r.get("input_cost", 0) for r in usage_records)
        total_output_cost = sum(r.get("output_cost", 0) for r in usage_records)
        status = "✅" if p.get("enabled") else "❌"

        # Per-model pricing
        model_prices = await get_model_prices_by_provider(p["id"])
        price_lines = "\n".join(
            f"    {mp['model']}：輸入 ${mp.get('input_price') or '—'} / 輸出 ${mp.get('output_price') or '—'}"
            for mp in model_prices
        ) if model_prices else "    （無模型定價）"

        lines.append(
            f"{status} {p['name']} ({p['api_type']})\n"
            f"  模型：{p.get('models', '(無)')}\n"
            f"  模型定價（每 1M tokens）：\n{price_lines}\n"
            f"  輸入 token: {total_input:,} / 輸出 token: {total_output:,}\n"
            f"  輸入費用: ${total_input_cost:.6f} / 輸出費用: ${total_output_cost:.6f}"
        )

    await update.message.reply_text("\n\n".join(lines))


# ============================================================
# /edit - Multi-turn conversation to edit a provider
# ============================================================

async def edit_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /edit - list providers for single select."""
    providers = await database.get_providers()
    if not providers:
        await update.message.reply_text("目前沒有任何提供商。")
        return _provider_end(context)


    context.user_data["providers_map"] = {str(i + 1): p for i, p in enumerate(providers)}
    lines = [f"{i + 1}. {p['name']} ({p['api_type']})" for i, p in enumerate(providers)]

    await update.message.reply_text("請回覆要編輯的提供商編號（不支持多選）：\n\n" + "\n".join(lines))
    return EDIT_PROVIDER_SELECT


async def edit_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive provider selection for edit."""
    text = update.message.text.strip()
    providers_map: dict = context.user_data.get("providers_map", {})

    if text not in providers_map:
        await update.message.reply_text("❌ 無效的編號。")
        return _provider_end(context)


    provider = providers_map[text]
    context.user_data["editing_provider"] = provider

    await update.message.reply_text(
        f"正在編輯: {provider['name']}\n\n"
        "請選擇要編輯的欄位：\n"
        "1. 名稱 (name)\n"
        "2. API 類型 (api_type)\n"
        "3. Base URL (base_url)\n"
        "4. API Key (api_key)\n"
        "5. 模型列表 (models)\n"
        "6. 模型定價 (pricing)\n"
        "7. 啟用狀態 (enabled)\n\n"
        "請回覆欄位名稱或編號："
    )
    return EDIT_PROVIDER_FIELD


async def edit_field(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive field to edit."""
    text = update.message.text.strip().lower()
    field_map = {
        "1": "name", "2": "api_type", "3": "base_url", "4": "api_key",
        "5": "models", "6": "pricing", "7": "enabled",
    }
    field = field_map.get(text, text)

    valid_fields = {"name", "api_type", "base_url", "api_key", "models", "pricing", "enabled"}
    if field not in valid_fields:
        await update.message.reply_text("❌ 無效的欄位。")
        return EDIT_PROVIDER_FIELD

    context.user_data["edit_field"] = field
    provider = context.user_data["editing_provider"]

    if field == "models":
        # Auto-fetch models from provider
        await update.message.reply_text("🔍 正在從提供商獲取模型列表...")
        from api.key_selector import get_first_key
        first_key = get_first_key(provider["api_key"])
        fetched = await fetch_provider_models(
            provider["base_url"], first_key, provider["api_type"]
        )

        if fetched:
            context.user_data["fetched_models"] = fetched

            header, footer = _build_model_selection_prompt(len(fetched))
            await _safe_reply_models(update, fetched, header=header, footer=footer)
            return EDIT_PROVIDER_MODELS_SELECT
        else:
            await update.message.reply_text(
                f"當前值: {provider.get('models', 'N/A')}\n"
                "⚠️ 無法獲取模型列表，請手動輸入新模型列表："
            )
            return EDIT_PROVIDER_VALUE
    elif field == "pricing":
        # Per-model pricing management — fetch from models.dev and show DB comparison
        current_models = [m.strip() for m in (provider.get("models") or "").split(",") if m.strip()]

        if not current_models:
            await update.message.reply_text("⚠️ 此提供商尚無模型，請先設定模型列表。")
            context.user_data.pop("editing_provider", None)
            context.user_data.pop("edit_field", None)
            return _provider_end(context)

        await update.message.reply_text("🔍 正在從 models.dev 獲取每個模型的定價...")
        pricing_map = await fetch_models_pricing(current_models)

        # Get current DB model prices
        from db.database import get_model_prices_by_provider
        db_prices = await get_model_prices_by_provider(provider["id"])
        db_price_map = {p["model"]: p for p in db_prices}

        lines: list[str] = []
        pricing_entries: list[dict] = []
        has_any = False

        for model_id in current_models:
            dev_p = pricing_map.get(model_id)
            db_p = db_price_map.get(model_id)
            current_input = db_p.get("input_price") if db_p else "—"
            current_output = db_p.get("output_price") if db_p else "—"

            if dev_p and (dev_p.get("input") is not None or dev_p.get("output") is not None):
                lines.append(
                    f"{model_id}：\n"
                    f"   models.dev：輸入 ${dev_p.get('input') or '—'} / 輸出 ${dev_p.get('output') or '—'}\n"
                    f"   當前資料庫：輸入 ${current_input} / 輸出 ${current_output}"
                )
                pricing_entries.append({
                    "model": model_id,
                    "input_price": dev_p.get("input"),
                    "output_price": dev_p.get("output"),
                })
                has_any = True
            else:
                lines.append(
                    f"{model_id}：未找到 models.dev 定價（當前：輸入 ${current_input} / 輸出 ${current_output}）"
                )

        context.user_data["edit_pricing_entries"] = pricing_entries
        context.user_data["edit_pricing_models"] = current_models

        if has_any:
            await update.message.reply_text(
                "📋 模型定價對比（每 1M tokens）：\n\n"
                + "\n\n".join(lines)
                + "\n\n1️⃣ 使用 models.dev 的定價更新全部\n"
                "2️⃣ 為所有模型手動設定統一定價\n"
                "3️⃣ 逐個設定每個模型的定價\n"
                "4️⃣ 跳過\n\n"
                "請選擇 1/2/3/4："
            )
            return EDIT_PROVIDER_PRICE_MODELSDEV
        else:
            # No models.dev pricing found — allow per-model manual pricing
            context.user_data["per_model_queue"] = current_models[:]
            context.user_data["per_model_entries"] = []
            first_model = current_models[0]
            await update.message.reply_text(
                "⚠️ 未從 models.dev 獲取到任何定價。\n\n"
                f"開始逐個設定模型定價。\n\n"
                f"📌 模型「{first_model}」\n"
                "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n"
                "或輸入 skip 跳過此模型："
            )
            return EDIT_PROVIDER_PRICE_PER_MODEL
    else:
        current = provider.get(field, "N/A")
        if field == "api_key":
            # Show key count instead of raw JSON
            from api.key_selector import parse_api_keys
            keys = parse_api_keys(current)
            current_display = f"{len(keys)} 個 API Key（{', '.join(k[:8] + '...' for k in keys)}）"
            await update.message.reply_text(
                f"當前值: {current_display}\n\n"
                "請輸入新的 API Key（可使用 , 分隔多個 API Key）："
            )
        else:
            await update.message.reply_text(f"當前值: {current}\n\n請輸入新值：")
        return EDIT_PROVIDER_VALUE


async def edit_value(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive new value for the editing field and update the provider."""
    text = update.message.text.strip()
    field = context.user_data.get("edit_field")

    if field == "api_key":
        # Parse comma-separated keys → JSON array
        import json
        keys = [k.strip() for k in text.replace("，", ",").split(",") if k.strip()]
        if not keys:
            await update.message.reply_text("❌ 未輸入有效的 API Key。")
            return EDIT_PROVIDER_VALUE
        value = json.dumps(keys)
    elif field == "enabled":
        value = text
    else:
        value = text

    return await _do_edit_update(update, context, value)


async def edit_models_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process model selection from fetched list in edit mode. Supports search keywords."""
    text = update.message.text.strip()
    text_lower = text.lower()
    all_fetched: list = context.user_data.get("fetched_models", [])

    # Check if we are in search mode
    search_results: list | None = context.user_data.get("search_results")

    if text_lower == "back":
        # Exit search mode, show full list again
        context.user_data.pop("search_results", None)
        header, footer = _build_model_selection_prompt(len(all_fetched))
        await _safe_reply_models(update, all_fetched, header=header, footer=footer)
        return EDIT_PROVIDER_MODELS_SELECT

    if text_lower == "all":
        if search_results is not None:
            models_value = ",".join(m["id"] for m in search_results)
            context.user_data.pop("search_results", None)
        else:
            models_value = ",".join(m["id"] for m in all_fetched)
    elif text_lower == "manual":
        context.user_data.pop("search_results", None)
        await update.message.reply_text("請手動輸入模型（用逗號分隔）：")
        return EDIT_PROVIDER_MODELS_MANUAL
    else:
        # Try to parse as number indices
        active_list = search_results if search_results is not None else all_fetched
        indices = []
        for part in text_lower.replace("，", ",").split(","):
            part = part.strip()
            if part.isdigit():
                n = int(part)
                if 1 <= n <= len(active_list):
                    indices.append(n)

        if indices:
            context.user_data.pop("search_results", None)
            indices = list(set(indices))
            models_value = ",".join(active_list[i - 1]["id"] for i in indices)
        else:
            # Treat as search keyword
            keyword = text.strip()
            filtered = _filter_models(all_fetched, keyword)
            if filtered:
                context.user_data["search_results"] = filtered
                header, footer = _build_model_selection_prompt(
                    len(filtered), is_search=True, search_keyword=keyword
                )
                await _safe_reply_models(update, filtered, header=header, footer=footer)
                return EDIT_PROVIDER_MODELS_SELECT
            else:
                await update.message.reply_text(
                    f'🔍 搜尋 "{keyword}" 沒有找到任何模型。\n'
                    "請嘗試其他關鍵字，或輸入編號 / all / manual："
                )
                return EDIT_PROVIDER_MODELS_SELECT

    context.user_data.pop("fetched_models", None)
    context.user_data["pending_models"] = models_value

    # Show per-model pricing with same format as edit_field → pricing
    return await _show_edit_models_pricing(update, context, models_value)


async def edit_models_manual(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive manually entered models in edit mode."""
    models_value = update.message.text.strip()
    context.user_data["pending_models"] = models_value

    return await _show_edit_models_pricing(update, context, models_value)


async def _show_edit_models_pricing(
    update: Update, context: ContextTypes.DEFAULT_TYPE, models_value: str
) -> int:
    """Shared logic: fetch models.dev pricing for new models, show comparison with 4 options.

    Used by both edit_models_select and edit_models_manual.
    """
    from db.database import get_model_prices_by_provider
    model_list = [m.strip() for m in models_value.split(",") if m.strip()]
    provider = context.user_data.get("editing_provider", {})
    provider_id = provider.get("id")

    if not model_list:
        return await _do_edit_update(update, context, models_value)

    await update.message.reply_text("🔍 正在從 models.dev 獲取每個新模型的定價...")
    pricing_map = await fetch_models_pricing(model_list)

    # Get current DB model prices
    db_prices = await get_model_prices_by_provider(provider_id)
    db_price_map = {p["model"]: p for p in db_prices}

    pricing_entries: list[dict] = []
    lines: list[str] = []
    has_any = False

    for model_id in model_list:
        dev_p = pricing_map.get(model_id)
        db_p = db_price_map.get(model_id)
        current_input = db_p.get("input_price") if db_p else "—"
        current_output = db_p.get("output_price") if db_p else "—"

        if dev_p and (dev_p.get("input") is not None or dev_p.get("output") is not None):
            lines.append(
                f"{model_id}：\n"
                f"   models.dev：輸入 ${dev_p.get('input') or '—'} / 輸出 ${dev_p.get('output') or '—'}\n"
                f"   當前資料庫：輸入 ${current_input} / 輸出 ${current_output}"
            )
            pricing_entries.append({
                "model": model_id,
                "input_price": dev_p.get("input"),
                "output_price": dev_p.get("output"),
            })
            has_any = True
        else:
            pricing_entries.append({"model": model_id, "input_price": None, "output_price": None})
            lines.append(
                f"{model_id}：未找到 models.dev 定價（當前：輸入 ${current_input} / 輸出 ${current_output}）"
            )

    context.user_data["edit_pricing_entries"] = pricing_entries
    context.user_data["edit_pricing_models"] = model_list

    if has_any:
        await update.message.reply_text(
            "📋 模型定價對比（每 1M tokens）：\n\n"
            + "\n\n".join(lines)
            + "\n\n1️⃣ 使用 models.dev 的定價更新全部\n"
            "2️⃣ 為所有模型手動設定統一定價\n"
            "3️⃣ 逐個設定每個模型的定價\n"
            "4️⃣ 只更新模型，不動定價\n\n"
            "請選擇 1/2/3/4："
        )
        return EDIT_PROVIDER_MODELS_PRICE_CONFIRM
    else:
        await update.message.reply_text("⚠️ 未從 models.dev 獲取到這些模型的定價，定價保持不變。")
        return await _do_edit_update(update, context, models_value)


async def edit_models_price_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process pricing confirmation after model change — 4 options matching edit_price_modelsdev."""
    from db.database import batch_upsert_model_prices
    text = update.message.text.strip()
    pricing_entries = context.user_data.pop("edit_pricing_entries", [])
    current_models = context.user_data.pop("edit_pricing_models", [])
    models_value = context.user_data.pop("pending_models", "")
    provider = context.user_data.get("editing_provider", {})
    provider_id = provider.get("id")

    if text == "1":
        # Use models.dev pricing — update models + pricing
        await database.update_provider(provider_id, models=models_value)
        valid_entries = [e for e in pricing_entries if e.get("input_price") is not None or e.get("output_price") is not None]
        if valid_entries:
            await batch_upsert_model_prices(provider_id, valid_entries)
            await update.message.reply_text(
                f"✅ 已更新模型和 {len(valid_entries)} 個模型的定價。\n"
                f"   模型：{models_value}"
            )
        else:
            await update.message.reply_text(f"✅ 已更新模型：{models_value}")
        context.user_data.pop("editing_provider", None)
        context.user_data.pop("edit_field", None)
        return _provider_end(context)

    elif text == "2":
        # Manual uniform pricing — update models first, then ask for price
        await database.update_provider(provider_id, models=models_value)
        context.user_data["editing_provider"] = await database.get_provider_by_id(provider_id)
        context.user_data["edit_pricing_models"] = current_models
        await update.message.reply_text("請輸入統一定價（格式：輸入價格,輸出價格，每 1M tokens）：")
        return EDIT_PROVIDER_PRICE_MANUAL
    elif text == "3":
        # Per-model manual pricing — update models first, then iterate
        await database.update_provider(provider_id, models=models_value)
        context.user_data["editing_provider"] = await database.get_provider_by_id(provider_id)
        context.user_data["per_model_queue"] = current_models[:]
        context.user_data["per_model_entries"] = []
        first_model = current_models[0]
        await update.message.reply_text(
            f"📌 開始逐個設定模型定價。\n\n"
            f"模型「{first_model}」\n"
            "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n"
            "或輸入 skip 跳過此模型："
        )
        return EDIT_PROVIDER_PRICE_PER_MODEL
    else:
        # text == "4" or any other — only update models
        return await _do_edit_update(update, context, models_value)


async def edit_price_modelsdev(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle per-model pricing selection from models.dev in edit mode."""
    from db.database import batch_upsert_model_prices
    text = update.message.text.strip()
    pricing_entries = context.user_data.pop("edit_pricing_entries", [])
    current_models = context.user_data.pop("edit_pricing_models", [])
    provider = context.user_data.get("editing_provider", {})
    provider_id = provider.get("id")

    if text == "1":
        # Use models.dev pricing for all models
        if pricing_entries:
            await batch_upsert_model_prices(provider_id, pricing_entries)
            await update.message.reply_text("✅ 已從 models.dev 更新所有模型定價。")
        context.user_data.pop("editing_provider", None)
        context.user_data.pop("edit_field", None)
        return _provider_end(context)

    elif text == "2":
        # Manual uniform pricing for all models
        await update.message.reply_text("請輸入統一定價（格式：輸入價格,輸出價格，每 1M tokens）：")
        context.user_data["edit_pricing_models"] = current_models
        return EDIT_PROVIDER_PRICE_MANUAL
    elif text == "3":
        # Per-model manual pricing — start iterating
        context.user_data["per_model_queue"] = current_models[:]
        context.user_data["per_model_entries"] = []
        first_model = current_models[0]
        await update.message.reply_text(
            f"📌 開始逐個設定模型定價。\n\n"
            f"模型「{first_model}」\n"
            "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n"
            "或輸入 skip 跳過此模型："
        )
        return EDIT_PROVIDER_PRICE_PER_MODEL
    else:
        await update.message.reply_text("已跳過，定價保持不變。")
        context.user_data.pop("editing_provider", None)
        context.user_data.pop("edit_field", None)
        return _provider_end(context)



async def edit_price_manual(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle manual price input in edit mode — applies uniform pricing to all models."""
    from db.database import batch_upsert_model_prices
    text = update.message.text.strip()
    provider = context.user_data.get("editing_provider", {})
    provider_id = provider.get("id")
    current_models = context.user_data.pop("edit_pricing_models", [])

    try:
        parts = text.split(",")
        input_price = float(parts[0])
        output_price = float(parts[1]) if len(parts) > 1 else 0.0
    except (ValueError, IndexError):
        await update.message.reply_text("❌ 請輸入格式：輸入價格,輸出價格")
        return EDIT_PROVIDER_PRICE_MANUAL

    if current_models:
        uniform_entries = [
            {"model": m, "input_price": input_price, "output_price": output_price}
            for m in current_models
        ]
        await batch_upsert_model_prices(provider_id, uniform_entries)
        await update.message.reply_text(
            f"✅ 已為 {len(current_models)} 個模型設定統一定價：${input_price}/${output_price}（每 1M tokens）"
        )
    else:
        await update.message.reply_text("❌ 沒有可設定定價的模型。")

    context.user_data.pop("editing_provider", None)
    context.user_data.pop("edit_field", None)
    return _provider_end(context)




async def edit_price_per_model(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle per-model manual pricing — iterate through models one by one."""
    from db.database import batch_upsert_model_prices
    text = update.message.text.strip()
    provider = context.user_data.get("editing_provider", {})
    provider_id = provider.get("id")
    queue: list = context.user_data.get("per_model_queue", [])
    entries: list = context.user_data.get("per_model_entries", [])

    # Process current model's input
    current_model = queue.pop(0) if queue else None

    if current_model and text.lower() != "skip":
        try:
            parts = text.split(",")
            input_price = float(parts[0])
            output_price = float(parts[1]) if len(parts) > 1 else 0.0
            entries.append({
                "model": current_model,
                "input_price": input_price,
                "output_price": output_price,
            })
        except (ValueError, IndexError):
            # Put model back and re-ask
            queue.insert(0, current_model)
            await update.message.reply_text(
                f"❌ 格式錯誤。請輸入格式：輸入價格,輸出價格\n"
                f"或輸入 skip 跳過「{current_model}」："
            )
            return EDIT_PROVIDER_PRICE_PER_MODEL

    # Ask for next model or finish
    if queue:
        next_model = queue[0]
        await update.message.reply_text(
            f"📌 模型「{next_model}」\n"
            "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n"
            "或輸入 skip 跳過此模型："
        )
        return EDIT_PROVIDER_PRICE_PER_MODEL
    else:
        # All done — save entries
        if entries:
            await batch_upsert_model_prices(provider_id, entries)
            lines = "\n".join(
                f"   {e['model']}：${e['input_price']}/${e['output_price']}"
                for e in entries
            )
            await update.message.reply_text(
                f"✅ 已設定 {len(entries)} 個模型的定價：\n{lines}"
            )
        else:
            await update.message.reply_text("未設定任何定價。")

        context.user_data.pop("per_model_queue", None)
        context.user_data.pop("per_model_entries", None)
        context.user_data.pop("editing_provider", None)
        context.user_data.pop("edit_field", None)
    return _provider_end(context)




async def _do_edit_update(update: Update, context: ContextTypes.DEFAULT_TYPE, value: Any) -> int:
    """Actually perform the provider field update."""
    field = context.user_data.get("edit_field")
    provider = context.user_data.get("editing_provider", {})
    provider_id = provider.get("id")

    # Type conversion
    if field == "enabled":
        value = 1 if str(value).lower() in ("1", "true", "yes", "啟用") else 0

    result = await database.update_provider(provider_id, **{field: value})
    if result:
        await update.message.reply_text(f"✅ 已更新 {field}。")
    else:
        await update.message.reply_text("❌ 更新失敗。")

    context.user_data.pop("editing_provider", None)
    context.user_data.pop("edit_field", None)
    return _provider_end(context)




# ============================================================
# /uu - Show all users' API key usage
# ============================================================

async def uu_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /uu - show all users' API key usage."""
    all_keys = await database.get_all_keys()
    if not all_keys:
        await update.message.reply_text("目前沒有任何 API key。")
        return

    lines = []
    current_user_id = None
    for k in all_keys:
        if not k.get("is_active"):
            continue
        if k.get("user_id") != current_user_id:
            current_user_id = k.get("user_id")
            username = k.get("username", "")
            tg_id = k.get("tg_user_id", "")
            lines.append(f"\n👤 {username or tg_id}")

        usage_records = await database.get_usage_by_key(k["id"])
        total_input = sum(r.get("input_tokens", 0) for r in usage_records)
        total_output = sum(r.get("output_tokens", 0) for r in usage_records)
        total_input_cost = sum(r.get("input_cost", 0) for r in usage_records)
        total_output_cost = sum(r.get("output_cost", 0) for r in usage_records)

        lines.append(
            f"  {k['key'][:20]}... "
            f"(輸入 token: {total_input:,} / 輸出 token: {total_output:,}) "
            f"(輸入費用: ${total_input_cost:.6f} / 輸出費用: ${total_output_cost:.6f})"
        )

    text = "\n".join(lines).strip()
    if not text:
        text = "暫無使用記錄。"
    await update.message.reply_text(text)


# ============================================================
# /admin_rm_userkey - Admin delete any user's API key
# ============================================================

# ============================================================
# /sub_url - Set/override API endpoint URL
# ============================================================

async def sub_url_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /sub_url conversation."""
    current = await database.get_setting("api_url")
    current_text = f"當前 URL: {current}\n\n" if current else ""
    await update.message.reply_text(f"{current_text}請輸入新的 API 接口 URL：")
    return SUB_URL_INPUT


async def sub_url_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Save new API URL."""
    url = update.message.text.strip()
    await database.set_setting("api_url", url)
    await update.message.reply_text(f"✅ API 接口已更新為: {url}")
    return ConversationHandler.END


# ============================================================
# Cancel handler
# ============================================================

async def cancel_conversation(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel any ongoing conversation."""
    await update.message.reply_text("❌ 操作已取消。")
    context.user_data.clear()
    return ConversationHandler.END


# ============================================================
# /api_test - Test API protocol reachability
# ============================================================


def _format_protocol_status(detection: dict) -> str:
    """Format DetectionResult into readable text with confidence and reasons.

    Args:
        detection: DetectionResult = {"protocols": dict[str, ProbeDetail], "recommended": str|None}
    """
    protocol_labels = {
        "openai_chat": "OpenAI (Chat Completions)",
        "openai_response": "OpenAI (Responses API)",
        "anthropic": "Anthropic (Messages)",
        "google": "Google (Gemini)",
    }
    _conf_icon = {"high": "✅", "medium": "⚠️", "low": "❓"}
    protocols = detection.get("protocols", {})
    recommended = detection.get("recommended")

    lines = []
    for proto, detail in protocols.items():
        label = protocol_labels.get(proto, proto)
        if detail["supported"]:
            icon = _conf_icon.get(detail["confidence"], "❓")
            lines.append(f"  {icon} {label} — {detail['reason']}")
        else:
            lines.append(f"  ❌ {label} — {detail['reason']}")

    if recommended:
        rec_label = protocol_labels.get(recommended, recommended)
        lines.append(f"\n  💡 建議：{rec_label}")

    return "\n".join(lines)


async def api_test_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /api_test conversation — ask for URL or URL,Key."""
    await update.message.reply_text(
        "🧪 API 協議測試\n\n"
        "請輸入要測試的 API URL（可附帶 Key）：\n\n"
        "格式：`URL` 或 `URL,API-KEY`\n\n"
        "例如：\n"
        "  `https://api.example.com/v1`\n"
        "  `https://api.example.com/v1,sk-xxxx`",
        parse_mode="Markdown"
    )
    return API_TEST_URL


async def api_test_url(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive URL (or URL,Key) and test protocols.

    Input format: 'URL' or 'URL,API-KEY'
    - If Key provided → directly test with auth
    - If URL only → test without auth, fall back to asking for Key if unreachable
    """
    raw = update.message.text.strip()

    # Parse "url,key" format — split on the FIRST comma only
    parts = raw.split(",", 1)
    url = parts[0].strip()
    api_key = parts[1].strip() if len(parts) > 1 else ""

    # If Key provided → directly test with auth
    if api_key:
        await update.message.reply_text("⏳ 正在使用 Key 偵測 API 協議...")

        detection = await detect_api_protocols(url, api_key)

        result_text = _format_protocol_status(detection)
        supported_count = sum(1 for d in detection["protocols"].values() if d["supported"])
        total = len(detection["protocols"])
        await update.message.reply_text(
            f"📊 偵測結果（帶 Key）：\n\n{result_text}\n\n"
            f"共 {supported_count}/{total} 個協議支援。"
        )
        return ConversationHandler.END

    # URL only → test without auth first
    context.user_data["api_test_url"] = url

    await update.message.reply_text("⏳ 正在偵測 API 協議（不帶 Key）...")

    detection, all_unreachable = await detect_protocols_no_auth(url)

    if all_unreachable:
        await update.message.reply_text(
            "⚠️ 所有協議都無法連通。\n"
            "可能是網路問題或需要認證。\n\n"
            "請輸入 API Key 重試，或輸入 /cancel 取消："
        )
        return API_TEST_KEY

    # Display results with confidence levels
    result_text = _format_protocol_status(detection)
    supported_count = sum(1 for d in detection["protocols"].values() if d["supported"])
    total = len(detection["protocols"])
    await update.message.reply_text(
        f"📊 偵測結果（不帶 Key）：\n\n{result_text}\n\n"
        f"共 {supported_count}/{total} 個協議支援。"
    )
    context.user_data.pop("api_test_url", None)
    return ConversationHandler.END


async def api_test_key(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive API key and retry protocol detection."""
    api_key = update.message.text.strip()
    url = context.user_data.get("api_test_url", "")

    await update.message.reply_text("⏳ 正在使用 Key 重新偵測 API 協議...")

    detection = await detect_api_protocols(url, api_key)

    result_text = _format_protocol_status(detection)
    supported_count = sum(1 for d in detection["protocols"].values() if d["supported"])
    total = len(detection["protocols"])
    await update.message.reply_text(
        f"📊 偵測結果（帶 Key）：\n\n{result_text}\n\n"
        f"共 {supported_count}/{total} 個協議支援。"
    )
    context.user_data.pop("api_test_url", None)
    return ConversationHandler.END


# ============================================================
# /admin_user - Unified user management menu (merges 5 commands)
# ============================================================

_ADMIN_USER_MENU_TEXT = (
    "👤 用戶管理\n\n"
    "請選擇操作：\n"
    "1. 新增用戶\n"
    "2. 停用用戶\n"
    "3. 刪除用戶\n"
    "4. 編輯用戶\n"
    "5. 移除用戶 API Key\n\n"
    "輸入數字選擇，或輸入 /cancel 離開："
)


async def admin_user_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Show user management menu."""
    await update.message.reply_text(_ADMIN_USER_MENU_TEXT)
    return ADMIN_USER_MENU


async def admin_user_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process menu selection and route to sub-flow."""
    text = update.message.text.strip()

    if text == "1":
        # Add user
        await update.message.reply_text("請輸入要新增的用戶 Telegram ID：")
        return ADMIN_USER_ADD_INPUT

    elif text == "2":
        # Stop user
        users = await database.get_users()
        users = [u for u in users if u.get("tg_user_id") != Config.ADMIN_ID]
        if not users:
            await update.message.reply_text("目前沒有其他用戶。\n\n" + _ADMIN_USER_MENU_TEXT)
            return ADMIN_USER_MENU

        context.user_data["admin_user_map"] = {str(i + 1): u for i, u in enumerate(users)}
        lines = [f"{i + 1}. {u.get('username', '')} (ID: {u['tg_user_id']})" for i, u in enumerate(users)]
        await update.message.reply_text(
            "請回覆要停用的用戶編號（多選用逗號分隔）：\n\n" + "\n".join(lines)
        )
        return ADMIN_USER_STOP_SELECT

    elif text == "3":
        # Delete user
        users = await database.get_users()
        users = [u for u in users if u.get("tg_user_id") != Config.ADMIN_ID]
        if not users:
            await update.message.reply_text("目前沒有其他用戶。\n\n" + _ADMIN_USER_MENU_TEXT)
            return ADMIN_USER_MENU

        context.user_data["admin_user_map"] = {str(i + 1): u for i, u in enumerate(users)}
        lines = [f"{i + 1}. {u.get('username', '')} (ID: {u['tg_user_id']})" for i, u in enumerate(users)]
        await update.message.reply_text(
            "請回覆要刪除的用戶編號（多選用逗號分隔）：\n\n" + "\n".join(lines)
        )
        return ADMIN_USER_DEL_SELECT

    elif text == "4":
        # Edit user
        users = await database.get_users()
        users = [u for u in users if u.get("tg_user_id") != Config.ADMIN_ID]
        if not users:
            await update.message.reply_text("目前沒有其他用戶。\n\n" + _ADMIN_USER_MENU_TEXT)
            return ADMIN_USER_MENU

        context.user_data["admin_user_map"] = {str(i + 1): u for i, u in enumerate(users)}
        lines = [f"{i + 1}. {u.get('username', '')} (ID: {u['tg_user_id']})" for i, u in enumerate(users)]
        await update.message.reply_text(
            "請回覆要編輯的用戶編號（不支持多選）：\n\n" + "\n".join(lines)
        )
        return ADMIN_USER_EDIT_SELECT

    elif text == "5":
        # Remove user API key
        all_keys = await database.get_all_keys()
        active_keys = [k for k in all_keys if k.get("is_active")]
        if not active_keys:
            await update.message.reply_text("目前沒有任何 API key。\n\n" + _ADMIN_USER_MENU_TEXT)
            return ADMIN_USER_MENU

        context.user_data["admin_user_keys_map"] = {str(i + 1): k["id"] for i, k in enumerate(active_keys)}
        lines = [f"{i + 1}. {k['key']} (用戶: {k.get('tg_user_id', k.get('username', 'N/A'))})" for i, k in enumerate(active_keys)]
        await update.message.reply_text(
            "請回覆要刪除的 API key 編號（多選用逗號分隔）：\n\n" + "\n".join(lines)
        )
        return ADMIN_USER_RM_KEY_SELECT

    else:
        await update.message.reply_text("❌ 無效的選擇，請輸入 1-5：\n\n" + _ADMIN_USER_MENU_TEXT)
        return ADMIN_USER_MENU


async def admin_user_add_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Add user from admin_user menu."""
    text = update.message.text.strip()
    try:
        tg_id = int(text)
    except ValueError:
        await update.message.reply_text("❌ 無效的用戶 ID，請輸入數字。\n\n" + _ADMIN_USER_MENU_TEXT)
        return ADMIN_USER_MENU

    existing = await database.get_user_by_tg_id(tg_id)
    if existing:
        if existing.get("is_active"):
            await update.message.reply_text("該用戶已存在且為活躍狀態。")
        else:
            await database.update_user_status(tg_id, 1)
            await update.message.reply_text("✅ 已重新啟用該用戶。")
    else:
        await database.add_user(tg_id)
        await update.message.reply_text(f"✅ 已新增用戶 {tg_id}。")

    await update.message.reply_text(_ADMIN_USER_MENU_TEXT)
    return ADMIN_USER_MENU


async def admin_user_stop_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process user stop selection from admin_user menu."""
    text = update.message.text.strip()
    users_map: dict = context.user_data.get("admin_user_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。\n\n" + _ADMIN_USER_MENU_TEXT)
        return ADMIN_USER_MENU

    stopped = 0
    for idx in indices:
        user = users_map.get(idx)
        if user:
            await database.update_user_status(user["tg_user_id"], 0)
            try:
                await context.bot.send_message(
                    chat_id=user["tg_user_id"],
                    text="你的帳號已被管理員停用",
                )
            except Exception:
                logger.warning("無法通知用戶 %s", user["tg_user_id"])
            stopped += 1

    await update.message.reply_text(f"✅ 已停用 {stopped} 個用戶。")
    context.user_data.pop("admin_user_map", None)
    await update.message.reply_text(_ADMIN_USER_MENU_TEXT)
    return ADMIN_USER_MENU


async def admin_user_del_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process user deletion from admin_user menu."""
    text = update.message.text.strip()
    users_map: dict = context.user_data.get("admin_user_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。\n\n" + _ADMIN_USER_MENU_TEXT)
        return ADMIN_USER_MENU

    deleted = 0
    for idx in indices:
        user = users_map.get(idx)
        if user:
            success = await database.delete_user(user["tg_user_id"])
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個用戶。")
    context.user_data.pop("admin_user_map", None)
    await update.message.reply_text(_ADMIN_USER_MENU_TEXT)
    return ADMIN_USER_MENU


async def admin_user_edit_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive user selection for edit from admin_user menu."""
    text = update.message.text.strip()
    users_map: dict = context.user_data.get("admin_user_map", {})

    if text not in users_map:
        await update.message.reply_text("❌ 無效的編號。\n\n" + _ADMIN_USER_MENU_TEXT)
        return ADMIN_USER_MENU

    user = users_map[text]
    context.user_data["editing_user"] = user

    await update.message.reply_text(
        "已收到您的請求，請在下則訊息給出完整用戶 ID 且不要包含其他內容"
    )
    return ADMIN_USER_EDIT_INPUT


async def admin_user_edit_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive new user TG ID from admin_user menu."""
    text = update.message.text.strip()
    try:
        new_tg_id = int(text)
    except ValueError:
        await update.message.reply_text("❌ 無效的用戶 ID，請輸入數字。\n\n" + _ADMIN_USER_MENU_TEXT)
        return ADMIN_USER_MENU

    user = context.user_data.get("editing_user", {})
    result = await database.update_user_tg_id(user["tg_user_id"], new_tg_id)

    if result:
        await update.message.reply_text(f"✅ 已更新用戶 ID: {user['tg_user_id']} → {new_tg_id}")
    else:
        await update.message.reply_text("❌ 更新失敗，新 ID 可能已存在。")

    context.user_data.pop("editing_user", None)
    await update.message.reply_text(_ADMIN_USER_MENU_TEXT)
    return ADMIN_USER_MENU


async def admin_user_rm_key_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process admin key deletion from admin_user menu."""
    text = update.message.text.strip()
    keys_map: dict = context.user_data.get("admin_user_keys_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。\n\n" + _ADMIN_USER_MENU_TEXT)
        return ADMIN_USER_MENU

    deleted = 0
    for idx in indices:
        key_id = keys_map.get(idx)
        if key_id:
            success = await database.delete_api_key(key_id)
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個 API key。")
    context.user_data.pop("admin_user_keys_map", None)
    await update.message.reply_text(_ADMIN_USER_MENU_TEXT)
    return ADMIN_USER_MENU


async def admin_user_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel admin_user conversation."""
    await update.message.reply_text("👋 已離開用戶管理。")
    context.user_data.pop("admin_user_map", None)
    context.user_data.pop("admin_user_keys_map", None)
    context.user_data.pop("editing_user", None)
    return ConversationHandler.END


# ============================================================
# Register all admin handlers
# ============================================================

def register_admin_handlers(app):
    """Register all admin command handlers."""
    from telegram.ext import CommandHandler, MessageHandler, filters
    from bot.filters import admin_filter

    # /list - simple command, no conversation
    app.add_handler(CommandHandler("list", list_command, filters=filters.User(user_id=Config.ADMIN_ID)))
    # /uu - simple command
    app.add_handler(CommandHandler("uu", uu_command, filters=filters.User(user_id=Config.ADMIN_ID)))

    # /provider — unified provider management (merges add/del/edit, /list kept standalone)
    _filt = filters.User(user_id=Config.ADMIN_ID)
    _txt = filters.TEXT & ~filters.COMMAND
    provider_conv = ConversationHandler(
        entry_points=[CommandHandler("provider", provider_start, filters=_filt)],
        states={
            PROVIDER_MENU: [MessageHandler(_txt, provider_menu)],
            PROVIDER_DEL_SELECT: [MessageHandler(_txt, provider_del_select)],
            # add sub-flow
            ADD_PROVIDER_NAME: [MessageHandler(_txt, add_name)],
            ADD_PROVIDER_TYPE: [MessageHandler(_txt, add_type)],
            ADD_PROVIDER_URL: [MessageHandler(_txt, add_url)],
            ADD_PROVIDER_KEY: [MessageHandler(_txt, add_key)],
            ADD_PROVIDER_MODELS_SELECT: [MessageHandler(_txt, add_models_select)],
            ADD_PROVIDER_MODELS_MANUAL: [MessageHandler(_txt, add_models_manual)],
            ADD_PROVIDER_PRICE_CONFIRM: [MessageHandler(_txt, add_price_confirm)],
            ADD_PROVIDER_PRICE_MANUAL: [MessageHandler(_txt, add_price_manual)],
            ADD_PROVIDER_PRICE_PER_MODEL: [MessageHandler(_txt, add_price_per_model)],
            # edit sub-flow
            EDIT_PROVIDER_SELECT: [MessageHandler(_txt, edit_select)],
            EDIT_PROVIDER_FIELD: [MessageHandler(_txt, edit_field)],
            EDIT_PROVIDER_VALUE: [MessageHandler(_txt, edit_value)],
            EDIT_PROVIDER_MODELS_SELECT: [MessageHandler(_txt, edit_models_select)],
            EDIT_PROVIDER_MODELS_MANUAL: [MessageHandler(_txt, edit_models_manual)],
            EDIT_PROVIDER_MODELS_PRICE_CONFIRM: [MessageHandler(_txt, edit_models_price_confirm)],
            EDIT_PROVIDER_PRICE_MODELSDEV: [MessageHandler(_txt, edit_price_modelsdev)],
            EDIT_PROVIDER_PRICE_MANUAL: [MessageHandler(_txt, edit_price_manual)],
            EDIT_PROVIDER_PRICE_PER_MODEL: [MessageHandler(_txt, edit_price_per_model)],
        },
        fallbacks=[CommandHandler("cancel", provider_cancel)],
    )
    app.add_handler(provider_conv)

    # /sub_url
    sub_url_conv = ConversationHandler(
        entry_points=[CommandHandler("sub_url", sub_url_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            SUB_URL_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, sub_url_input)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(sub_url_conv)

    # /admin_user — unified user management (merges add/stop/del/edit_user + admin_rm_userkey)
    admin_user_conv = ConversationHandler(
        entry_points=[CommandHandler("admin_user", admin_user_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            ADMIN_USER_MENU: [MessageHandler(filters.TEXT & ~filters.COMMAND, admin_user_menu)],
            ADMIN_USER_ADD_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, admin_user_add_input)],
            ADMIN_USER_STOP_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, admin_user_stop_select)],
            ADMIN_USER_DEL_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, admin_user_del_select)],
            ADMIN_USER_EDIT_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, admin_user_edit_select)],
            ADMIN_USER_EDIT_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, admin_user_edit_input)],
            ADMIN_USER_RM_KEY_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, admin_user_rm_key_select)],
        },
        fallbacks=[CommandHandler("cancel", admin_user_cancel)],
    )
    app.add_handler(admin_user_conv)

    # /api_test
    api_test_conv = ConversationHandler(
        entry_points=[CommandHandler("api_test", api_test_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            API_TEST_URL: [MessageHandler(filters.TEXT & ~filters.COMMAND, api_test_url)],
            API_TEST_KEY: [MessageHandler(filters.TEXT & ~filters.COMMAND, api_test_key)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(api_test_conv)
