"""
Admin handlers - Admin-only commands for the Telegram Bot.

Commands: /add, /del, /list, /edit, /uu, /admin_rm_userkey,
          /sub_url, /add_user, /stop_user, /del_user, /edit_user
"""
import logging
from typing import Any

from telegram import Update
from telegram.ext import ContextTypes, ConversationHandler

from config import Config
from db import database
from bot.keyboards import make_numbered_list_keyboard
from bot.handlers.model_fetcher import fetch_provider_models, fetch_models_pricing, detect_api_protocols

logger = logging.getLogger(__name__)

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
    DEL_PROVIDER_SELECT,
    SUB_URL_INPUT,
    ADD_USER_INPUT,
    STOP_USER_SELECT,
    DEL_USER_SELECT,
    EDIT_USER_SELECT,
    EDIT_USER_INPUT,
    RM_USERKEY_SELECT,
) = range(24)


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
    await update.message.reply_text("請輸入 API Key：")
    return ADD_PROVIDER_KEY


async def add_key(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive provider API key, auto-detect protocols, then ask user to select type."""
    context.user_data["new_provider"]["api_key"] = update.message.text.strip()
    provider = context.user_data["new_provider"]

    # Auto-detect supported API protocols
    await update.message.reply_text("🔍 正在偵測 API 端點支持的協議...")
    protocols = await detect_api_protocols(provider["base_url"], provider["api_key"])

    # Build display with reachability status
    protocol_labels = {
        "openai_chat": "openai (Chat Completions)",
        "openai_response": "openai_response (Responses API)",
        "anthropic": "anthropic",
        "google": "google",
    }
    type_map = {"1": "openai_chat", "2": "openai_response", "3": "anthropic", "4": "google"}

    any_reachable = any(protocols.values())
    lines = []
    for i, (key, label) in enumerate(protocol_labels.items(), 1):
        status = "✅ 可連通" if protocols.get(key) else "❌ 無法連通"
        lines.append(f"{i}. {label} — {status}")

    if any_reachable:
        await update.message.reply_text(
            "📡 API 端點偵測結果：\n\n"
            + "\n".join(lines)
            + "\n\n請選擇 API 類型（輸入數字或名稱）："
        )
    else:
        await update.message.reply_text(
            "📡 API 端點偵測結果：\n\n"
            + "\n".join(lines)
            + "\n\n⚠️ 自動偵測不到任何可用的 API 協議，請手動確認後選擇類型："
        )

    context.user_data["detected_protocols"] = protocols
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
    fetched = await fetch_provider_models(
        provider["base_url"], provider["api_key"], provider["api_type"]
    )

    if fetched:
        # Show list for user to select
        display = fetched[:50]
        lines = [f"{i + 1}. {m['id']}" for i, m in enumerate(display)]
        suffix = f"\n...還有 {len(fetched) - 50} 個" if len(fetched) > 50 else ""
        context.user_data["fetched_models"] = fetched

        await update.message.reply_text(
            f"✅ 獲取到 {len(fetched)} 個模型：\n\n"
            + "\n".join(lines)
            + suffix
            + "\n\n請選擇模型（輸入編號，多選用逗號分隔）\n"
            '或輸入 "all" 全選\n'
            '或輸入 "manual" 手動輸入：'
        )
        return ADD_PROVIDER_MODELS_SELECT
    else:
        await update.message.reply_text(
            "⚠️ 無法從提供商獲取模型列表。\n"
            "請手動輸入支持的模型列表（用逗號分隔，如: gpt-4o,gpt-4o-mini）："
        )
        return ADD_PROVIDER_MODELS_MANUAL


async def add_models_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process model selection from fetched list."""
    text = update.message.text.strip().lower()
    fetched: list = context.user_data.get("fetched_models", [])

    if text == "all":
        models = ",".join(m["id"] for m in fetched)
    elif text == "manual":
        await update.message.reply_text("請手動輸入模型（用逗號分隔）：")
        return ADD_PROVIDER_MODELS_MANUAL
    else:
        indices = []
        for part in text.replace("，", ",").split(","):
            part = part.strip()
            if part.isdigit():
                n = int(part)
                if 1 <= n <= len(fetched):
                    indices.append(n)
        if not indices:
            await update.message.reply_text("❌ 無效的選擇，已取消。")
            context.user_data.pop("new_provider", None)
            return ConversationHandler.END
        indices = list(set(indices))
        models = ",".join(fetched[i - 1]["id"] for i in indices)

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
    return ConversationHandler.END


# ============================================================
# /del - Multi-select delete providers
# ============================================================

async def del_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /del - list providers for multi-select."""
    providers = await database.get_providers()
    if not providers:
        await update.message.reply_text("目前沒有任何提供商。")
        return ConversationHandler.END

    context.user_data["providers_map"] = {str(i + 1): p["id"] for i, p in enumerate(providers)}
    lines = [f"{i + 1}. {p['name']} ({p['api_type']})" for i, p in enumerate(providers)]

    await update.message.reply_text(
        "請回覆要刪除的提供商編號（多選用逗號分隔，如: 1,2）：\n\n" + "\n".join(lines)
    )
    return DEL_PROVIDER_SELECT


async def del_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process deletion selection."""
    text = update.message.text.strip()
    providers_map: dict = context.user_data.get("providers_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。")
        return ConversationHandler.END

    deleted = 0
    for idx in indices:
        provider_id = providers_map.get(idx)
        if provider_id:
            success = await database.delete_provider(provider_id)
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個提供商。")
    context.user_data.pop("providers_map", None)
    return ConversationHandler.END


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
        return ConversationHandler.END

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
        return ConversationHandler.END

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
        fetched = await fetch_provider_models(
            provider["base_url"], provider["api_key"], provider["api_type"]
        )

        if fetched:
            display = fetched[:50]
            lines = [f"{i + 1}. {m['id']}" for i, m in enumerate(display)]
            suffix = f"\n...還有 {len(fetched) - 50} 個" if len(fetched) > 50 else ""
            context.user_data["fetched_models"] = fetched

            await update.message.reply_text(
                f"✅ 獲取到 {len(fetched)} 個模型：\n\n"
                + "\n".join(lines)
                + suffix
                + "\n\n請選擇模型（輸入編號，多選用逗號分隔）\n"
                '或輸入 "all" 全選\n'
                '或輸入 "manual" 手動輸入：'
            )
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
            return ConversationHandler.END

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
        await update.message.reply_text(f"當前值: {provider.get(field, 'N/A')}\n\n請輸入新值：")
        return EDIT_PROVIDER_VALUE


async def edit_models_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process model selection from fetched list in edit mode."""
    text = update.message.text.strip().lower()
    fetched: list = context.user_data.get("fetched_models", [])

    if text == "all":
        models_value = ",".join(m["id"] for m in fetched)
    elif text == "manual":
        await update.message.reply_text("請手動輸入模型（用逗號分隔）：")
        return EDIT_PROVIDER_MODELS_MANUAL
    else:
        indices = []
        for part in text.replace("，", ",").split(","):
            part = part.strip()
            if part.isdigit():
                n = int(part)
                if 1 <= n <= len(fetched):
                    indices.append(n)
        if not indices:
            await update.message.reply_text("❌ 無效的選擇，已取消。")
            context.user_data.pop("editing_provider", None)
            context.user_data.pop("edit_field", None)
            return ConversationHandler.END
        indices = list(set(indices))
        models_value = ",".join(fetched[i - 1]["id"] for i in indices)

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
        return ConversationHandler.END
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
        return ConversationHandler.END
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
        return ConversationHandler.END


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
    return ConversationHandler.END


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
        return ConversationHandler.END


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
    return ConversationHandler.END


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

async def rm_userkey_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """List all API keys for admin to delete."""
    all_keys = await database.get_all_keys()
    active_keys = [k for k in all_keys if k.get("is_active")]

    if not active_keys:
        await update.message.reply_text("目前沒有任何 API key。")
        return ConversationHandler.END

    context.user_data["keys_map"] = {str(i + 1): k["id"] for i, k in enumerate(active_keys)}
    lines = [f"{i + 1}. {k['key']} (用戶: {k.get('tg_user_id', k.get('username', 'N/A'))})" for i, k in enumerate(active_keys)]

    await update.message.reply_text(
        "請回覆要刪除的 API key 編號（多選用逗號分隔）：\n\n" + "\n".join(lines)
    )
    return RM_USERKEY_SELECT


async def rm_userkey_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process admin key deletion."""
    text = update.message.text.strip()
    keys_map: dict = context.user_data.get("keys_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。")
        return ConversationHandler.END

    deleted = 0
    for idx in indices:
        key_id = keys_map.get(idx)
        if key_id:
            success = await database.delete_api_key(key_id)
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個 API key。")
    context.user_data.pop("keys_map", None)
    return ConversationHandler.END


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
# /add_user - Add a trusted user
# ============================================================

async def add_user_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start /add_user conversation."""
    await update.message.reply_text("請輸入要新增的用戶 Telegram ID：")
    return ADD_USER_INPUT


async def add_user_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Add user by TG ID."""
    text = update.message.text.strip()
    try:
        tg_id = int(text)
    except ValueError:
        await update.message.reply_text("❌ 無效的用戶 ID，請輸入數字。")
        return ADD_USER_INPUT

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

    return ConversationHandler.END


# ============================================================
# /stop_user - Stop (disable) users
# ============================================================

async def stop_user_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """List users for admin to stop."""
    users = await database.get_users()
    # Exclude admin
    users = [u for u in users if u.get("tg_user_id") != Config.ADMIN_ID]

    if not users:
        await update.message.reply_text("目前沒有其他用戶。")
        return ConversationHandler.END

    context.user_data["users_map"] = {str(i + 1): u for i, u in enumerate(users)}
    lines = [f"{i + 1}. {u.get('username', '')} (ID: {u['tg_user_id']})" for i, u in enumerate(users)]

    await update.message.reply_text(
        "請回覆要停用的用戶編號（多選用逗號分隔）：\n\n" + "\n".join(lines)
    )
    return STOP_USER_SELECT


async def stop_user_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process user stop selection."""
    text = update.message.text.strip()
    users_map: dict = context.user_data.get("users_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。")
        return ConversationHandler.END

    stopped = 0
    for idx in indices:
        user = users_map.get(idx)
        if user:
            await database.update_user_status(user["tg_user_id"], 0)
            # Try to notify the user
            try:
                await context.bot.send_message(
                    chat_id=user["tg_user_id"],
                    text="你的帳號已被管理員停用",
                )
            except Exception:
                logger.warning("無法通知用戶 %s", user["tg_user_id"])
            stopped += 1

    await update.message.reply_text(f"✅ 已停用 {stopped} 個用戶。")
    context.user_data.pop("users_map", None)
    return ConversationHandler.END


# ============================================================
# /del_user - Delete users
# ============================================================

async def del_user_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """List users for admin to delete."""
    users = await database.get_users()
    users = [u for u in users if u.get("tg_user_id") != Config.ADMIN_ID]

    if not users:
        await update.message.reply_text("目前沒有其他用戶。")
        return ConversationHandler.END

    context.user_data["users_map"] = {str(i + 1): u for i, u in enumerate(users)}
    lines = [f"{i + 1}. {u.get('username', '')} (ID: {u['tg_user_id']})" for i, u in enumerate(users)]

    await update.message.reply_text(
        "請回覆要刪除的用戶編號（多選用逗號分隔）：\n\n" + "\n".join(lines)
    )
    return DEL_USER_SELECT


async def del_user_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process user deletion."""
    text = update.message.text.strip()
    users_map: dict = context.user_data.get("users_map", {})

    try:
        indices = [idx.strip() for idx in text.split(",")]
    except Exception:
        await update.message.reply_text("❌ 格式錯誤。")
        return ConversationHandler.END

    deleted = 0
    for idx in indices:
        user = users_map.get(idx)
        if user:
            success = await database.delete_user(user["tg_user_id"])
            if success:
                deleted += 1

    await update.message.reply_text(f"✅ 已刪除 {deleted} 個用戶。")
    context.user_data.pop("users_map", None)
    return ConversationHandler.END


# ============================================================
# /edit_user - Edit user TG ID
# ============================================================

async def edit_user_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """List users for admin to edit."""
    users = await database.get_users()
    users = [u for u in users if u.get("tg_user_id") != Config.ADMIN_ID]

    if not users:
        await update.message.reply_text("目前沒有其他用戶。")
        return ConversationHandler.END

    context.user_data["users_map"] = {str(i + 1): u for i, u in enumerate(users)}
    lines = [f"{i + 1}. {u.get('username', '')} (ID: {u['tg_user_id']})" for i, u in enumerate(users)]

    await update.message.reply_text(
        "請回覆要編輯的用戶編號（不支持多選）：\n\n" + "\n".join(lines)
    )
    return EDIT_USER_SELECT


async def edit_user_select(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive user selection for edit."""
    text = update.message.text.strip()
    users_map: dict = context.user_data.get("users_map", {})

    if text not in users_map:
        await update.message.reply_text("❌ 無效的編號。")
        return ConversationHandler.END

    user = users_map[text]
    context.user_data["editing_user"] = user

    await update.message.reply_text(
        "已收到您的請求，請在下則訊息給出完整用戶 ID 且不要包含其他內容"
    )
    return EDIT_USER_INPUT


async def edit_user_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receive new user TG ID."""
    text = update.message.text.strip()
    try:
        new_tg_id = int(text)
    except ValueError:
        await update.message.reply_text("❌ 無效的用戶 ID，請輸入數字。")
        return EDIT_USER_INPUT

    user = context.user_data.get("editing_user", {})
    result = await database.update_user_tg_id(user["tg_user_id"], new_tg_id)

    if result:
        await update.message.reply_text(f"✅ 已更新用戶 ID: {user['tg_user_id']} → {new_tg_id}")
    else:
        await update.message.reply_text("❌ 更新失敗，新 ID 可能已存在。")

    context.user_data.pop("editing_user", None)
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

    # /add - multi-turn conversation
    add_conv = ConversationHandler(
        entry_points=[CommandHandler("add", add_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            ADD_PROVIDER_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_name)],
            ADD_PROVIDER_TYPE: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_type)],
            ADD_PROVIDER_URL: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_url)],
            ADD_PROVIDER_KEY: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_key)],
            ADD_PROVIDER_MODELS_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_models_select)],
            ADD_PROVIDER_MODELS_MANUAL: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_models_manual)],
            ADD_PROVIDER_PRICE_CONFIRM: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_price_confirm)],
            ADD_PROVIDER_PRICE_MANUAL: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_price_manual)],
            ADD_PROVIDER_PRICE_PER_MODEL: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_price_per_model)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(add_conv)

    # /del - multi-select conversation
    del_conv = ConversationHandler(
        entry_points=[CommandHandler("del", del_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            DEL_PROVIDER_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, del_select)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(del_conv)

    # /edit - multi-turn conversation
    edit_conv = ConversationHandler(
        entry_points=[CommandHandler("edit", edit_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            EDIT_PROVIDER_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_select)],
            EDIT_PROVIDER_FIELD: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_field)],
            EDIT_PROVIDER_VALUE: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_value)],
            EDIT_PROVIDER_MODELS_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_models_select)],
            EDIT_PROVIDER_MODELS_MANUAL: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_models_manual)],
            EDIT_PROVIDER_MODELS_PRICE_CONFIRM: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_models_price_confirm)],
            EDIT_PROVIDER_PRICE_MODELSDEV: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_price_modelsdev)],
            EDIT_PROVIDER_PRICE_MANUAL: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_price_manual)],
            EDIT_PROVIDER_PRICE_PER_MODEL: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_price_per_model)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(edit_conv)

    # /admin_rm_userkey
    rm_userkey_conv = ConversationHandler(
        entry_points=[CommandHandler("admin_rm_userkey", rm_userkey_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            RM_USERKEY_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, rm_userkey_select)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(rm_userkey_conv)

    # /sub_url
    sub_url_conv = ConversationHandler(
        entry_points=[CommandHandler("sub_url", sub_url_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            SUB_URL_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, sub_url_input)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(sub_url_conv)

    # /add_user
    add_user_conv = ConversationHandler(
        entry_points=[CommandHandler("add_user", add_user_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            ADD_USER_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_user_input)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(add_user_conv)

    # /stop_user
    stop_user_conv = ConversationHandler(
        entry_points=[CommandHandler("stop_user", stop_user_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            STOP_USER_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, stop_user_select)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(stop_user_conv)

    # /del_user
    del_user_conv = ConversationHandler(
        entry_points=[CommandHandler("del_user", del_user_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            DEL_USER_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, del_user_select)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(del_user_conv)

    # /edit_user
    edit_user_conv = ConversationHandler(
        entry_points=[CommandHandler("edit_user", edit_user_start, filters=filters.User(user_id=Config.ADMIN_ID))],
        states={
            EDIT_USER_SELECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_user_select)],
            EDIT_USER_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_user_input)],
        },
        fallbacks=[CommandHandler("cancel", cancel_conversation)],
    )
    app.add_handler(edit_user_conv)
