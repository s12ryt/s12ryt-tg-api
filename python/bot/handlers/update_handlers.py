"""
Bot handlers for in-built update commands.

/version  — Show current program version (admin only)
/update   — Check for updates + confirm via inline keyboard (admin only)
/restart  — Restart the process immediately (admin only)
"""

from __future__ import annotations

import logging

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, filters

from bot.filters import admin_filter
from config import Config
from updater import (
    fetch_and_check_update,
    get_current_version,
    is_working_dir_clean,
    perform_update,
    restart_process,
)

logger = logging.getLogger(__name__)


# ============================================================
# 輔助函數
# ============================================================


def _format_date(iso_date: str) -> str:
    """格式化日期顯示"""
    if not iso_date:
        return "—"
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(iso_date)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return iso_date


# ============================================================
# /version — 查看當前版本
# ============================================================


async def version_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Show current program version."""
    try:
        version = get_current_version()
        tag_line = f"🏷️ Release：`{version.tag}`\n" if version.tag else ""
        await update.message.reply_text(
            f"📦 *目前版本*\n\n"
            f"{tag_line}"
            f"🔖 Commit：`{version.hash}`\n"
            f"📝 訊息：{version.message}\n"
            f"🕐 時間：{_format_date(version.date)}",
            parse_mode="Markdown",
        )
    except Exception as e:
        await update.message.reply_text(f"❌ 取得版本失敗：{e}")


# ============================================================
# /update — 檢查更新 + 確認執行
# ============================================================


async def update_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Check for updates and show confirmation inline keyboard."""
    try:
        await update.message.reply_text("⏳ 正在檢查更新...")

        result = fetch_and_check_update()

        if not result.has_update:
            tag_line = f"🏷️ Release：`{result.current.tag}`\n" if result.current.tag else ""
            await update.message.reply_text(
                f"✅ 已是最新版本！\n\n"
                f"{tag_line}"
                f"🔖 Commit：`{result.current.hash}`\n"
                f"📝 {result.current.message}\n"
                f"🕐 {_format_date(result.current.date)}",
                parse_mode="Markdown",
            )
            return

        # 有更新可用
        tag_line = f"🏷️ `{result.current.tag}`\n" if result.current.tag else ""
        msg = (
            f"🔄 *有新版本可用！*\n\n"
            f"📍 *當前版本*\n"
            f"{tag_line}"
            f"🔖 `{result.current.hash}`\n"
            f"📝 {result.current.message}\n"
            f"🕐 {_format_date(result.current.date)}\n\n"
        )

        # 顯示 GitHub Release 資訊
        if result.latest_release:
            rel = result.latest_release
            pre_label = " *(預發布)*" if rel.prerelease else " *(穩定版)*"
            msg += (
                f"🆕 *GitHub 最新 Release*\n"
                f"🏷️ `{rel.tag}`{pre_label}\n"
                f"📝 {rel.name}\n"
                f"🕐 {_format_date(rel.published_at)}\n"
            )
            if result.current.tag and rel.tag:
                msg += f"🔗 [查看 Release]({rel.html_url})\n"
            msg += "\n"

        # 顯示落後 commit 數量
        if result.commits_behind > 0:
            msg += f"📊 落後 {result.commits_behind} 個提交\n"
            display = result.new_commits[:10]
            if display:
                msg += f"\n📜 *新增提交：*\n{chr(10).join(display)}"
                if len(result.new_commits) > 10:
                    msg += f"\n... 還有 {len(result.new_commits) - 10} 條"

        # 檢查工作目錄
        if not is_working_dir_clean():
            msg += "\n\n⚠️ *警告：工作目錄有未提交的更改！*\n更新將改用 tarball 下載方式。"

        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton("✅ 確認更新", callback_data="update_confirm"),
                InlineKeyboardButton("❌ 取消", callback_data="update_cancel"),
            ]
        ])

        await update.message.reply_text(
            msg,
            parse_mode="Markdown",
            reply_markup=keyboard,
        )
    except Exception as e:
        await update.message.reply_text(f"❌ 檢查更新失敗：{e}")


# ============================================================
# /restart — 立即重啟
# ============================================================


async def restart_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Restart the process immediately."""
    await update.message.reply_text(
        "🔄 *正在重啟進程...*\n\nBot 將在 2 秒後重新上線。",
        parse_mode="Markdown",
    )
    logger.info("[restart] 由管理員觸發重啟")
    await restart_process(2.0)


# ============================================================
# Callback Query 處理
# ============================================================


async def handle_update_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle the update confirmation callback."""
    query = update.callback_query
    # Admin check for callback queries (no filters= param for CallbackQueryHandler)
    if not update.effective_user or update.effective_user.id != Config.ADMIN_ID:
        await query.answer(text="⛔ 此操作僅限管理員。", show_alert=True)
        return
    try:
        await query.answer()
        await query.edit_message_text(
            "⏳ 正在更新程式碼...\n\n嘗試 git pull，失敗則改用 tarball 下載。"
        )

        result = perform_update()

        if result.success:
            method_text = "📦 tarball 下載" if result.method == "tarball" else "📥 git pull"
            await query.edit_message_text(
                f"✅ {result.message}\n\n"
                f"🔧 更新方式：{method_text}\n\n"
                f"🔄 正在重啟進程...\nBot 將在 2 秒後重新上線。"
            )
            logger.info("[update] 更新成功，正在重啟...")
            await restart_process(2.0)
        else:
            await query.edit_message_text(f"❌ {result.message}")
    except Exception as e:
        try:
            await query.answer()
        except Exception as e2:
            logger.debug("query.answer failed in update error handler: %s", e2)
        try:
            await query.edit_message_text(f"❌ 更新失敗：{e}")
        except Exception as e2:
            logger.warning("Failed to notify user about update error: %s", e2)


async def handle_update_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle the update cancel callback."""
    query = update.callback_query
    if not update.effective_user or update.effective_user.id != Config.ADMIN_ID:
        await query.answer(text="⛔ 此操作僅限管理員。", show_alert=True)
        return
    try:
        await query.answer(text="已取消更新")
        await query.edit_message_text("🚫 已取消更新。")
    except Exception as e:
        logger.debug("Failed to acknowledge update cancel: %s", e)


# ============================================================
# 註冊 Handler
# ============================================================


def register_update_handlers(app: Application) -> None:
    """Register all update-related command handlers (admin only)."""
    app.add_handler(CommandHandler("version", version_command, filters=admin_filter))
    app.add_handler(CommandHandler("update", update_command, filters=admin_filter))
    app.add_handler(CommandHandler("restart", restart_command, filters=admin_filter))

    # Callback queries
    app.add_handler(CallbackQueryHandler(handle_update_confirm, pattern="^update_confirm$"))
    app.add_handler(CallbackQueryHandler(handle_update_cancel, pattern="^update_cancel$"))
