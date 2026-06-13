"""
Bot handlers for permission management commands.

/limits — Admin command to manage user groups, user limits, and API key limits.
/my_limits — User command to view their own limits and current usage.
"""

from __future__ import annotations

import logging

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, filters

from bot.filters import trusted_user_filter
from config import Config
from db import database as db

logger = logging.getLogger(__name__)

_filt = filters.Async(trusted_user_filter.filter_async)


# ============================================================
# /my_limits — User command
# ============================================================


async def my_limits_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Show the user's effective limits and current usage."""
    tg_user_id = update.effective_user.id
    user = await db.get_user_by_tg_id(tg_user_id)
    if not user:
        await update.message.reply_text("您還不是受信任的用戶。請聯繫管理員。")
        return

    user_id = user["id"]
    keys = await db.get_keys_by_user(user_id)
    api_key_id = keys[0]["id"] if keys else None

    limits = await db.get_effective_limits(user_id, api_key_id)
    daily = await db.get_daily_usage(user_id, api_key_id)
    monthly = await db.get_monthly_usage(user_id, api_key_id)

    def _fmt_limit(val, unit=""):
        if val == 0:
            return "∞ (無限制)"
        return f"{val:,}{unit}"

    def _fmt_cost(val):
        if val == 0:
            return "∞ (無限制)"
        return f"${val:.4f}"

    def _fmt_usage(val, limit, unit=""):
        if limit == 0:
            return f"{val:,}{unit} / ∞"
        pct = (val / limit * 100) if limit > 0 else 0
        return f"{val:,}{unit} / {limit:,}{unit} ({pct:.1f}%)"

    def _fmt_cost_usage(val, limit):
        if limit == 0:
            return f"${val:.4f} / ∞"
        pct = (val / limit * 100) if limit > 0 else 0
        return f"${val:.4f} / ${limit:.4f} ({pct:.1f}%)"

    lines = [
        "📋 **您的使用限制**\n",
        f"期限: {_fmt_expiry(limits.get('expires_at'))}",
        f"RPM (每分鐘請求): {_fmt_limit(limits['rpm'])}",
        f"TPM (每分鐘 Token): {_fmt_limit(limits['tpm'])}",
        f"並發請求數: {_fmt_limit(limits['concurrency'])}",
        f"每日 Token: {_fmt_usage(daily['total_tokens'], limits['daily_token_limit'])}",
        f"每月 Token: {_fmt_usage(monthly['total_tokens'], limits['monthly_token_limit'])}",
        f"每日費用: {_fmt_cost_usage(daily['total_cost'], limits['daily_cost_limit'])}",
        f"每月費用: {_fmt_cost_usage(monthly['total_cost'], limits['monthly_cost_limit'])}",
    ]

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


def _fmt_expiry(expires_at: str | None) -> str:
    if not expires_at:
        return "無限期"
    if db.is_expired(expires_at):
        return f"⚠️ 已過期 ({expires_at})"
    return expires_at


# ============================================================
# /limits — Admin command
# ============================================================


async def limits_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Admin command to manage permission limits."""
    if update.effective_user.id != Config.ADMIN_ID:
        await update.message.reply_text("此指令僅限管理員使用。")
        return

    if not context.args:
        await _limits_help(update)
        return

    sub = context.args[0].lower()

    if sub == "groups":
        await _limits_list_groups(update)
    elif sub == "group" and len(context.args) >= 2:
        action = context.args[1].lower()
        if action == "add" and len(context.args) >= 3:
            await _limits_group_add(update, context.args[2:])
        elif action == "del" and len(context.args) >= 3:
            await _limits_group_del(update, context.args[2:])
        elif action == "set" and len(context.args) >= 4:
            await _limits_group_set(update, context.args[2:])
        elif action == "show" and len(context.args) >= 3:
            await _limits_group_show(update, context.args[2:])
        else:
            await _limits_help(update)
    elif sub == "user" and len(context.args) >= 2:
        action = context.args[1].lower()
        if action == "set" and len(context.args) >= 4:
            await _limits_user_set(update, context.args[2:])
        elif action == "show" and len(context.args) >= 3:
            await _limits_user_show(update, context.args[2:])
        else:
            await _limits_help(update)
    elif sub == "key" and len(context.args) >= 2:
        action = context.args[1].lower()
        if action == "set" and len(context.args) >= 4:
            await _limits_key_set(update, context.args[2:])
        elif action == "show" and len(context.args) >= 3:
            await _limits_key_show(update, context.args[2:])
        else:
            await _limits_help(update)
    else:
        await _limits_help(update)


async def _limits_help(update: Update) -> None:
    """Show help for /limits command."""
    help_text = """📋 **權限管理指令**

**用戶組管理:**
`/limits groups` — 列出所有用戶組
`/limits group add <name> [rpm=60] [tpm=10000] [concurrency=5] [daily_token=100000] [monthly_token=1000000] [daily_cost=1.0] [monthly_cost=10.0]` — 新增用戶組
`/limits group del <name>` — 刪除用戶組（用戶移至預設組）
`/limits group set <name> <field>=<value> [field=value ...]` — 修改用戶組設定
`/limits group show <name>` — 查看用戶組詳情

**用戶限制:**
`/limits user set <tg_user_id> group=<group_name>` — 設定用戶的組
`/limits user set <tg_user_id> rpm=60 tpm=10000 daily_token=50000 expires_at=2025-12-31` — 設定用戶覆蓋值
`/limits user show <tg_user_id>` — 查看用戶有效限制

**API Key 限制:**
`/limits key set <api_key_id> rpm=30 tpm=5000 daily_token=20000 expires_at=2025-06-30` — 設定 Key 覆蓋值
`/limits key show <api_key_id>` — 查看 Key 有效限制

**可用欄位:** rpm, tpm, concurrency, daily_token, monthly_token, daily_cost, monthly_cost, expires_at
**特殊值:** 0 = 無限制, 不填 = 繼承上層"""
    await update.message.reply_text(help_text, parse_mode="Markdown")


async def _limits_list_groups(update: Update) -> None:
    groups = await db.get_user_groups()
    if not groups:
        await update.message.reply_text("目前沒有用戶組。")
        return

    lines = ["📋 **用戶組列表**\n"]
    for g in groups:
        default_tag = " (預設)" if g["is_default"] else ""
        lines.append(
            f"• `{g['name']}`{default_tag}\n"
            f"  RPM={g['rpm_limit']} TPM={g['tpm_limit']} 並發={g['concurrency_limit']}\n"
            f"  日Token={g['daily_token_limit']} 月Token={g['monthly_token_limit']}\n"
            f"  日費=${g['daily_cost_limit']:.2f} 月費=${g['monthly_cost_limit']:.2f}"
        )
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


_FIELD_MAP = {
    "rpm": "rpm_limit",
    "tpm": "tpm_limit",
    "concurrency": "concurrency_limit",
    "daily_token": "daily_token_limit",
    "monthly_token": "monthly_token_limit",
    "daily_cost": "daily_cost_limit",
    "monthly_cost": "monthly_cost_limit",
}

_USER_OVERRIDE_FIELDS = {
    "rpm": "rpm_override",
    "tpm": "tpm_override",
    "concurrency": "concurrency_override",
    "daily_token": "daily_token_override",
    "monthly_token": "monthly_token_override",
    "daily_cost": "daily_cost_override",
    "monthly_cost": "monthly_cost_override",
    "expires_at": "expires_at",
}


def _parse_kv_args(args: list[str]) -> dict:
    """Parse key=value pairs from args. Returns dict."""
    result = {}
    for arg in args:
        if "=" in arg:
            k, v = arg.split("=", 1)
            k = k.strip().lower()
            v = v.strip()
            result[k] = v
    return result


def _parse_numeric(val: str) -> int | float:
    if "." in val:
        return float(val)
    return int(val)


async def _limits_group_add(update: Update, args: list[str]) -> None:
    name = args[0]
    if "=" in name:
        await update.message.reply_text("第一個參數必須是用戶組名稱（不含 = 號）。")
        return

    kv = _parse_kv_args(args[1:])
    kwargs = {}
    for short_name, db_field in _FIELD_MAP.items():
        if short_name in kv:
            try:
                kwargs[db_field] = _parse_numeric(kv[short_name])
            except ValueError:
                await update.message.reply_text(f"無效的數值: {short_name}={kv[short_name]}")
                return

    result = await db.add_user_group(name, display_name=name, **kwargs)
    if result:
        await update.message.reply_text(f"✅ 用戶組 `{name}` 已建立。", parse_mode="Markdown")
    else:
        await update.message.reply_text(f"❌ 用戶組 `{name}` 已存在。", parse_mode="Markdown")


async def _limits_group_del(update: Update, args: list[str]) -> None:
    name = args[0]
    group = await db.get_user_group_by_name(name)
    if not group:
        await update.message.reply_text(f"❌ 找不到用戶組 `{name}`。", parse_mode="Markdown")
        return
    try:
        await db.delete_user_group(group["id"])
        await update.message.reply_text(f"✅ 用戶組 `{name}` 已刪除。用戶已移至預設組。", parse_mode="Markdown")
    except ValueError as e:
        await update.message.reply_text(f"❌ {e}")


async def _limits_group_set(update: Update, args: list[str]) -> None:
    name = args[0]
    group = await db.get_user_group_by_name(name)
    if not group:
        await update.message.reply_text(f"❌ 找不到用戶組 `{name}`。", parse_mode="Markdown")
        return

    kv = _parse_kv_args(args[1:])
    kwargs = {}
    for short_name, db_field in _FIELD_MAP.items():
        if short_name in kv:
            try:
                kwargs[db_field] = _parse_numeric(kv[short_name])
            except ValueError:
                await update.message.reply_text(f"無效的數值: {short_name}={kv[short_name]}")
                return

    if not kwargs:
        await update.message.reply_text("沒有提供要修改的欄位。")
        return

    result = await db.update_user_group(group["id"], **kwargs)
    await update.message.reply_text(f"✅ 用戶組 `{name}` 已更新。", parse_mode="Markdown")


async def _limits_group_show(update: Update, args: list[str]) -> None:
    name = args[0]
    group = await db.get_user_group_by_name(name)
    if not group:
        await update.message.reply_text(f"❌ 找不到用戶組 `{name}`。", parse_mode="Markdown")
        return

    default_tag = " (預設)" if group["is_default"] else ""
    lines = [
        f"📋 **用戶組: {group['name']}**{default_tag}\n",
        f"顯示名稱: {group.get('display_name', '-')}",
        f"RPM: {group['rpm_limit']}",
        f"TPM: {group['tpm_limit']}",
        f"並發: {group['concurrency_limit']}",
        f"每日 Token: {group['daily_token_limit']}",
        f"每月 Token: {group['monthly_token_limit']}",
        f"每日費用: ${group['daily_cost_limit']:.4f}",
        f"每月費用: ${group['monthly_cost_limit']:.4f}",
    ]
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def _limits_user_set(update: Update, args: list[str]) -> None:
    tg_user_id_str = args[0]
    try:
        tg_user_id = int(tg_user_id_str)
    except ValueError:
        await update.message.reply_text(f"無效的 Telegram User ID: {tg_user_id_str}")
        return

    user = await db.get_user_by_tg_id(tg_user_id)
    if not user:
        await update.message.reply_text(f"❌ 找不到用戶 (TG ID: {tg_user_id})。")
        return

    kv = _parse_kv_args(args[1:])

    # Handle group= separately
    if "group" in kv:
        group = await db.get_user_group_by_name(kv["group"])
        if not group:
            await update.message.reply_text(f"❌ 找不到用戶組 `{kv['group']}`。", parse_mode="Markdown")
            return
        await db.set_user_group(user["id"], group["id"])
        await update.message.reply_text(
            f"✅ 用戶 {tg_user_id} 已設為組 `{group['name']}`。", parse_mode="Markdown"
        )

    # Handle overrides
    overrides = {}
    for short_name, db_field in _USER_OVERRIDE_FIELDS.items():
        if short_name in kv:
            val = kv[short_name]
            if short_name == "expires_at":
                overrides["expires_at"] = val
            else:
                try:
                    overrides[db_field] = _parse_numeric(val)
                except ValueError:
                    await update.message.reply_text(f"無效的數值: {short_name}={val}")
                    return

    if overrides:
        await db.set_user_overrides(user["id"], **overrides)
        await update.message.reply_text(
            f"✅ 用戶 {tg_user_id} 的覆蓋值已設定。"
        )


async def _limits_user_show(update: Update, args: list[str]) -> None:
    tg_user_id_str = args[0]
    try:
        tg_user_id = int(tg_user_id_str)
    except ValueError:
        await update.message.reply_text(f"無效的 Telegram User ID: {tg_user_id_str}")
        return

    user = await db.get_user_by_tg_id(tg_user_id)
    if not user:
        await update.message.reply_text(f"❌ 找不到用戶 (TG ID: {tg_user_id})。")
        return

    user_id = user["id"]
    keys = await db.get_keys_by_user(user_id)
    api_key_id = keys[0]["id"] if keys else None

    limits = await db.get_effective_limits(user_id, api_key_id)
    daily = await db.get_daily_usage(user_id, api_key_id)
    monthly = await db.get_monthly_usage(user_id, api_key_id)

    group = None
    if user.get("group_id"):
        group = await db.get_user_group_by_id(user["group_id"])
    if not group:
        group = await db.get_default_user_group()

    lines = [
        f"📋 **用戶限制 (TG ID: {tg_user_id})**\n",
        f"用戶組: {group['name'] if group else '無'}",
        f"期限: {_fmt_expiry(limits.get('expires_at'))}",
        f"RPM: {limits['rpm']}",
        f"TPM: {limits['tpm']}",
        f"並發: {limits['concurrency']}",
        f"每日 Token: {daily['total_tokens']:,} / {limits['daily_token_limit'] or '∞'}",
        f"每月 Token: {monthly['total_tokens']:,} / {limits['monthly_token_limit'] or '∞'}",
        f"每日費用: ${daily['total_cost']:.4f} / ${limits['daily_cost_limit']:.4f}" if limits['daily_cost_limit'] else f"每日費用: ${daily['total_cost']:.4f} / ∞",
        f"每月費用: ${monthly['total_cost']:.4f} / ${limits['monthly_cost_limit']:.4f}" if limits['monthly_cost_limit'] else f"每月費用: ${monthly['total_cost']:.4f} / ∞",
    ]

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def _limits_key_set(update: Update, args: list[str]) -> None:
    api_key_id_str = args[0]
    try:
        api_key_id = int(api_key_id_str)
    except ValueError:
        await update.message.reply_text(f"無效的 API Key ID: {api_key_id_str}")
        return

    key = await db.get_api_key_with_limits(api_key_id)
    if not key:
        await update.message.reply_text(f"❌ 找不到 API Key ID: {api_key_id}。")
        return

    kv = _parse_kv_args(args[1:])
    overrides = {}
    for short_name, db_field in _USER_OVERRIDE_FIELDS.items():
        if short_name in kv:
            val = kv[short_name]
            if short_name == "expires_at":
                overrides["expires_at"] = val
            else:
                try:
                    overrides[db_field] = _parse_numeric(val)
                except ValueError:
                    await update.message.reply_text(f"無效的數值: {short_name}={val}")
                    return

    if overrides:
        await db.set_api_key_overrides(api_key_id, **overrides)
        await update.message.reply_text(f"✅ API Key {api_key_id} 的覆蓋值已設定。")
    else:
        await update.message.reply_text("沒有提供要修改的欄位。")


async def _limits_key_show(update: Update, args: list[str]) -> None:
    api_key_id_str = args[0]
    try:
        api_key_id = int(api_key_id_str)
    except ValueError:
        await update.message.reply_text(f"無效的 API Key ID: {api_key_id_str}")
        return

    key = await db.get_api_key_with_limits(api_key_id)
    if not key:
        await update.message.reply_text(f"❌ 找不到 API Key ID: {api_key_id}。")
        return

    user_id = key["user_id"]
    limits = await db.get_effective_limits(user_id, api_key_id)

    lines = [
        f"📋 **API Key 限制 (ID: {api_key_id})**\n",
        f"用戶 ID: {user_id}",
        f"期限: {_fmt_expiry(limits.get('expires_at'))}",
        f"RPM: {limits['rpm']}",
        f"TPM: {limits['tpm']}",
        f"並發: {limits['concurrency']}",
        f"每日 Token: {limits['daily_token_limit']}",
        f"每月 Token: {limits['monthly_token_limit']}",
        f"每日費用: ${limits['daily_cost_limit']:.4f}",
        f"每月費用: ${limits['monthly_cost_limit']:.4f}",
    ]

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ============================================================
# Registration
# ============================================================


def register_limit_handlers(app: Application) -> None:
    """Register all limit management command handlers."""
    app.add_handler(CommandHandler("limits", limits_command, filters=_filt))
    app.add_handler(CommandHandler("my_limits", my_limits_command, filters=_filt))
