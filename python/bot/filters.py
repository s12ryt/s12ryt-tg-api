"""
Custom filters for the Telegram Bot.
Filters for admin users and trusted (active) users.
"""
from telegram import Update
from telegram.ext import filters, BaseFilter

from config import Config
from db import database


class AdminFilter(BaseFilter):
    """Filter messages from the admin user only."""

    def filter(self, update: Update) -> bool:
        if not update.effective_user:
            return False
        return update.effective_user.id == Config.ADMIN_ID


class TrustedUserFilter(BaseFilter):
    """Filter messages from trusted (active) users, including admin."""

    async def filter_async(self, update: Update) -> bool:
        if not update.effective_user:
            return False
        # Admin is always trusted
        if update.effective_user.id == Config.ADMIN_ID:
            return True
        user = await database.get_user_by_tg_id(update.effective_user.id)
        return user is not None and user.get("is_active", 0) == 1


# Singleton instances
admin_filter = AdminFilter()
trusted_user_filter = TrustedUserFilter()
