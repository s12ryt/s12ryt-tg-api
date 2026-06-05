import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    BOT_TOKEN: str = os.getenv("BOT_TOKEN", "")
    ADMIN_ID: int = int(os.getenv("ADMIN_ID", "0"))
    API_PORT: int = int(os.getenv("API_PORT", "8000"))
    DATABASE_PATH: str = os.getenv("DATABASE_PATH", "./data/bot.db")
    DEFAULT_API_URL: str = os.getenv("DEFAULT_API_URL", "http://localhost:8000")
