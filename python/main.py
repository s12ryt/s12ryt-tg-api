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
    register_user_handlers(application)
    register_admin_handlers(application)
    logger.info("已註冊所有 Bot 處理器")

    # 啟動 API 代理服務器（異步並行）
    async def post_init(application):
        """啟動後的初始化：設置指令選單 + 啟動 API 服務器"""
        # 設置 Bot 指令列表
        from telegram import BotCommand
        user_commands = [
            BotCommand("start", "開始使用 Bot"),
            BotCommand("url", "獲取 API 接口地址"),
            BotCommand("key", "查看我的 API Key"),
            BotCommand("key_add", "新增 API Key"),
            BotCommand("key_del", "刪除 API Key"),
            BotCommand("usage", "查詢 Token 用量"),
        ]
        admin_commands = [
            BotCommand("add", "新增提供商"),
            BotCommand("del", "刪除提供商"),
            BotCommand("list", "列出所有提供商"),
            BotCommand("edit", "編輯提供商"),
            BotCommand("uu", "查詢用戶用量"),
            BotCommand("admin_rm_userkey", "刪除用戶 Key"),
            BotCommand("sub_url", "修改 API 接口地址"),
            BotCommand("add_user", "新增用戶"),
            BotCommand("stop_user", "停用用戶"),
            BotCommand("del_user", "刪除用戶"),
            BotCommand("edit_user", "編輯用戶"),
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
