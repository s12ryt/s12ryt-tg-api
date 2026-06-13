"""
s12ryt-tg-api Python 版本
Telegram Bot + API 聚合代理服務入口
"""
import asyncio
import logging
import os
import sys

from telegram.ext import ApplicationBuilder

from config import Config
from db.database import init_db

# 設定日誌
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


def main():
    """主入口函數"""
    # 驗證配置
    if not Config.BOT_TOKEN:
        logger.error("BOT_TOKEN 未設定！請在 .env 文件中設定。")
        sys.exit(1)

    if not Config.ADMIN_ID:
        logger.error("ADMIN_ID 未設定！請在 .env 文件中設定。")
        sys.exit(1)

    # 初始化數據庫
    asyncio.run(init_db())
    logger.info("數據庫初始化完成")

    # 建立 Bot Application
    application = ApplicationBuilder().token(Config.BOT_TOKEN).build()

    # 註冊處理器
    from bot.handlers.user_handlers import register_user_handlers
    from bot.handlers.admin_handlers import register_admin_handlers
    from bot.handlers.limit_handlers import register_limit_handlers
    register_user_handlers(application)
    register_admin_handlers(application)
    register_limit_handlers(application)
    logger.info("已註冊所有 Bot 處理器")

    # 指令日誌 — group -1 在所有 group 0 handler 之前執行，不會阻擋後續處理
    from telegram.ext import MessageHandler, filters as tg_filters

    async def _log_command(update, context):
        """每次指令調用時在控制台打印用戶 ID、時間和指令詳情。"""
        user = update.effective_user
        text = update.effective_message.text or ""
        command = text.split()[0] if text else "/?"
        args = text[len(command):].strip()
        logger.info(
            "[CMD] user=%s (@%s) %s%s",
            user.id,
            user.username or "",
            command,
            f" args={args}" if args else "",
        )

    application.add_handler(
        MessageHandler(tg_filters.COMMAND, _log_command), group=-1
    )

    # 啟動 API 代理服務器（異步並行）
    async def post_init(application):
        """啟動後的初始化：設置指令選單 + 啟動 API 服務器"""
        # 設置 Bot 指令列表
        from telegram import BotCommand
        user_commands = [
            BotCommand("start", "開始使用 Bot"),
            BotCommand("url", "獲取 API 接口地址"),
            BotCommand("key", "API Key 管理（查看/新增/刪除）"),
            BotCommand("usage", "查詢 Token 用量"),
            BotCommand("coding", "Coding 模式管理（開關/設定）"),
            BotCommand("model_catch", "抓取 API 模型列表"),
            BotCommand("my_limits", "查看使用限制與配額"),
        ]
        admin_commands = [
            BotCommand("provider", "供應商管理（新增/刪除/編輯/列表）"),
            BotCommand("uu", "查詢用戶用量"),
            BotCommand("admin_user", "用戶管理（新增/停用/刪除/編輯/移除Key）"),
            BotCommand("sub_url", "修改 API 接口地址"),
            BotCommand("api_test", "測試 API 協議連通性"),
            BotCommand("limits", "權限管理（用戶組/限制/配額）"),
        ]
        try:
            await application.bot.set_my_commands(user_commands + admin_commands)
            logger.info("已設置 Bot 指令選單")
        except Exception as e:
            logger.error("設置指令選單失敗: %s", e)

        # 啟動 API 服務器
        from api.server import app
        import uvicorn
        config = uvicorn.Config(app, host="0.0.0.0", port=Config.API_PORT, log_level="info")
        server = uvicorn.Server(config)
        asyncio.create_task(server.serve())
        logger.info("API 代理服務器已在 port %s 啟動", Config.API_PORT)

    application.post_init = post_init

    logger.info("Bot 正在啟動...")
    application.run_polling()


if __name__ == "__main__":
    main()
