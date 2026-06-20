"""
程式內置更新模組

功能：
  - 透過 GitHub Releases API 查詢最新版本
  - 執行更新：git pull（主要）→ tarball 下載（備援）
  - 自動重啟進程 (os.execv)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ============================================================
# 常數
# ============================================================

GITHUB_OWNER = "s12ryt"
GITHUB_REPO = "s12ryt-tg-api"
GITHUB_API_BASE = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}"


# ============================================================
# 資料結構
# ============================================================


@dataclass
class VersionInfo:
    """版本資訊"""
    hash: str           # 短 commit hash
    date: str           # ISO 8601 提交時間
    message: str        # 提交訊息第一行
    tag: str | None = None  # 最近的 git tag


@dataclass
class ReleaseInfo:
    """GitHub Release 資訊"""
    tag: str            # Release tag 名稱
    name: str           # Release 標題
    prerelease: bool    # 是否為預發布版本
    published_at: str   # 發布時間 (ISO 8601)
    html_url: str       # Release 頁面 URL
    tarball_url: str    # Tarball 下載 URL


@dataclass
class UpdateCheckResult:
    """更新檢查結果"""
    has_update: bool
    current: VersionInfo
    latest_release: ReleaseInfo | None = None
    commits_behind: int = 0
    new_commits: list[str] = field(default_factory=list)


@dataclass
class UpdateResult:
    """更新執行結果"""
    success: bool
    message: str
    method: str | None = None  # "git" 或 "tarball"
    new_hash: str | None = None


# ============================================================
# Git 輔助函數
# ============================================================


def _run_git(args: list[str], timeout: int = 30) -> str:
    """執行 git 命令，回傳 stdout（已 strip）"""
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode != 0:
            err = (result.stderr or "").strip()
            out = (result.stdout or "").strip()
            raise RuntimeError(err or out or f"git {' '.join(args)} failed (exit {result.returncode})")
        return (result.stdout or "").strip()
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {' '.join(args)} timed out after {timeout}s")


def _is_git_repo() -> bool:
    """判斷當前目錄是否為 git 倉庫"""
    try:
        _run_git(["rev-parse", "--git-dir"])
        return True
    except Exception:
        return False


def _parse_version_info(ref: str) -> VersionInfo:
    """從 git ref 取得版本資訊"""
    hash_ = _run_git(["rev-parse", "--short", ref])
    date = _run_git(["log", "-1", "--format=%cI", ref])
    message = _run_git(["log", "-1", "--format=%s", ref])
    tag = None
    try:
        tag = _run_git(["describe", "--tags", "--abbrev=0", ref])
    except Exception:
        pass  # 沒有 tag
    return VersionInfo(hash=hash_, date=date, message=message, tag=tag)


# ============================================================
# SemVer 工具
# ============================================================


def _parse_semver(version: str) -> tuple[int, int, int, str | None]:
    """解析 SemVer 字串，回傳 (major, minor, patch, prerelease)"""
    clean = version.lstrip("v")
    if "-" in clean:
        main_part, pre_part = clean.split("-", 1)
    else:
        main_part, pre_part = clean, None

    parts = main_part.split(".")
    major = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
    minor = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    patch = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
    return major, minor, patch, pre_part


def _compare_semver(a: str, b: str) -> int:
    """
    比較兩個 SemVer 版本
    回傳：正數 a 較新，負數 b 較新，0 相等
    """
    ma, mi, pa, pre_a = _parse_semver(a)
    mb, mi_b, pb, pre_b = _parse_semver(b)

    if ma != mb:
        return ma - mb
    if mi != mi_b:
        return mi - mi_b
    if pa != pb:
        return pa - pb

    # 沒有 prerelease 的比有 prerelease 的新
    if not pre_a and pre_b:
        return 1
    if pre_a and not pre_b:
        return -1
    if pre_a and pre_b:
        if pre_a < pre_b:
            return -1
        elif pre_a > pre_b:
            return 1
    return 0


# ============================================================
# GitHub API
# ============================================================


def get_latest_release() -> ReleaseInfo | None:
    """
    取得最新 stable Release（非 prerelease）
    如果沒有 stable release，回傳 None
    """
    try:
        url = f"{GITHUB_API_BASE}/releases/latest"
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": f"{GITHUB_OWNER}-{GITHUB_REPO}-updater",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                return None
            data: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
            return ReleaseInfo(
                tag=data.get("tag_name", ""),
                name=data.get("name") or data.get("tag_name", ""),
                prerelease=data.get("prerelease", False),
                published_at=data.get("published_at") or data.get("created_at", ""),
                html_url=data.get("html_url", ""),
                tarball_url=data.get("tarball_url", ""),
            )
    except Exception as e:
        logger.warning("[updater] GitHub API 取得失敗：%s", e)
        return None


# ============================================================
# 公開 API
# ============================================================


def get_current_version() -> VersionInfo:
    """取得當前版本資訊"""
    if not _is_git_repo():
        # Fallback: git 不可用時（tarball 安裝），從 VERSION 檔案讀版本
        try:
            version_file = os.path.join(os.path.dirname(__file__), "..", "VERSION")
            with open(version_file, "r", encoding="utf-8") as f:
                version = f.read().strip()
            if version:
                return VersionInfo(hash="unknown", date="", message="", tag=f"v{version}")
        except Exception:
            pass
        return VersionInfo(hash="unknown", date="", message="", tag=None)
    return _parse_version_info("HEAD")


def fetch_and_check_update() -> UpdateCheckResult:
    """
    檢查是否有更新可用。

    同時透過 GitHub Releases API 取得最新版本資訊，
    以及 git fetch 取得落後的 commit 數量。
    """
    current = get_current_version()

    # Step 1: 透過 GitHub API 取得最新 Release
    latest_release = get_latest_release()

    # Step 2: Git fetch 取得遠端最新狀態
    commits_behind = 0
    new_commits: list[str] = []
    git_has_update = False

    if _is_git_repo():
        try:
            _run_git(["fetch", "origin", "main"])

            current_full = _run_git(["rev-parse", "HEAD"])
            latest_full = _run_git(["rev-parse", "origin/main"])
            git_has_update = current_full != latest_full

            if git_has_update:
                log_output = _run_git([
                    "log", "--oneline", "--no-decorate",
                    "HEAD..origin/main",
                ])
                if log_output:
                    new_commits = [line for line in log_output.split("\n") if line]
                    commits_behind = len(new_commits)
        except Exception:
            pass  # git fetch 失敗（網路問題），但 GitHub API 可能成功

    # Step 3: 判斷是否有更新
    has_update = git_has_update

    # 如果 GitHub API 顯示有更新的 tag 版本，也算有更新
    if latest_release and current.tag:
        if _compare_semver(latest_release.tag, current.tag) > 0:
            has_update = True
    elif latest_release and not current.tag:
        has_update = True

    return UpdateCheckResult(
        has_update=has_update,
        current=current,
        latest_release=latest_release,
        commits_behind=commits_behind,
        new_commits=new_commits,
    )


def is_working_dir_clean() -> bool:
    """檢查工作目錄是否乾淨（沒有未提交的更改）"""
    if not _is_git_repo():
        return True
    status = _run_git(["status", "--porcelain"])
    return len(status) == 0


# ============================================================
# 更新方法
# ============================================================


def _update_via_git() -> UpdateResult:
    """方法 1：透過 git pull 更新"""
    try:
        if not _is_git_repo():
            return UpdateResult(success=False, message="不是 git 倉庫，無法使用 git pull。")
        if not is_working_dir_clean():
            return UpdateResult(
                success=False,
                message="工作目錄有未提交的更改，請先處理後再更新。",
            )
        _run_git(["pull", "origin", "main"])
        new_hash = _run_git(["rev-parse", "--short", "HEAD"])
        return UpdateResult(
            success=True,
            message=f"git pull 更新成功！新版本：{new_hash}",
            method="git",
            new_hash=new_hash,
        )
    except Exception as e:
        return UpdateResult(success=False, message=f"git pull 失敗：{e}")


def _update_via_tarball(tarball_url: str) -> UpdateResult:
    """
    方法 2：透過下載 Release tarball 更新（備援方案）

    下載 GitHub tarball → 解壓 → 複製原始碼（保留 data/ 目錄）
    """
    tmpdir_ctx = tempfile.mkdtemp(prefix="s12ryt-update-")

    try:
        # Step 1: 下載 tarball
        req = urllib.request.Request(
            tarball_url,
            headers={"User-Agent": f"{GITHUB_OWNER}-{GITHUB_REPO}-updater"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            tarball_data = resp.read()

        tarball_path = os.path.join(tmpdir_ctx, "release.tar.gz")
        with open(tarball_path, "wb") as f:
            f.write(tarball_data)

        # Step 2: 解壓縮
        with tarfile.open(tarball_path, "r:gz") as tar:
            tar.extractall(tmpdir_ctx)

        # Step 3: 找到解壓後的目錄
        extracted_name = None
        for item in os.listdir(tmpdir_ctx):
            full_path = os.path.join(tmpdir_ctx, item)
            if item != "release.tar.gz" and os.path.isdir(full_path):
                extracted_name = item
                break

        if not extracted_name:
            raise RuntimeError("解壓縮失敗：找不到解壓目錄")

        extracted_path = os.path.join(tmpdir_ctx, extracted_name)
        cwd = os.getcwd()

        # Step 4: 複製檔案，保留 data/ 目錄
        for entry in os.listdir(extracted_path):
            src = os.path.join(extracted_path, entry)
            dst = os.path.join(cwd, entry)

            if entry in ("nodejs", "python"):
                _sync_dir_preserving_data(src, dst)
            elif entry in (".git", "data"):
                continue
            else:
                if os.path.exists(dst):
                    if os.path.isdir(dst):
                        shutil.rmtree(dst)
                    else:
                        os.remove(dst)
                if os.path.isdir(src):
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)

        # Step 5: 取得新版本資訊
        new_hash = "unknown"
        try:
            new_hash = _run_git(["rev-parse", "--short", "HEAD"])
        except Exception:
            pass

        return UpdateResult(
            success=True,
            message="Tarball 下載更新成功！",
            method="tarball",
            new_hash=new_hash,
        )
    except Exception as e:
        return UpdateResult(success=False, message=f"Tarball 更新失敗：{e}")
    finally:
        shutil.rmtree(tmpdir_ctx, ignore_errors=True)


def _sync_dir_preserving_data(src: str, dest: str) -> None:
    """複製目錄內容，但保留 data/ 和 node_modules/ 子目錄"""
    for entry in os.listdir(src):
        if entry in ("data", "node_modules"):
            continue

        src_path = os.path.join(src, entry)
        dest_path = os.path.join(dest, entry)

        if os.path.exists(dest_path):
            if os.path.isdir(dest_path):
                shutil.rmtree(dest_path)
            else:
                os.remove(dest_path)

        if os.path.isdir(src_path):
            shutil.copytree(src_path, dest_path)
        else:
            shutil.copy2(src_path, dest_path)


def perform_update() -> UpdateResult:
    """執行更新：先嘗試 git pull，失敗則下載 tarball"""
    # 方法 1: git pull
    git_result = _update_via_git()
    if git_result.success:
        return git_result

    logger.warning("[updater] git pull 失敗，嘗試 tarball 下載...")

    # 方法 2: tarball 下載
    release = get_latest_release()
    if release:
        tarball_result = _update_via_tarball(release.tarball_url)
        if tarball_result.success:
            return tarball_result
        return UpdateResult(
            success=False,
            message=f"兩種更新方式都失敗。\ngit: {git_result.message}\ntarball: {tarball_result.message}",
        )

    # 沒有 Release 可用，嘗試下載 main 分支的 tarball
    try:
        branch_url = f"{GITHUB_API_BASE}/tarball/main"
        tarball_result = _update_via_tarball(branch_url)
        if tarball_result.success:
            return tarball_result
        return UpdateResult(
            success=False,
            message=f"兩種更新方式都失敗。\ngit: {git_result.message}\ntarball: {tarball_result.message}",
        )
    except Exception as e:
        return UpdateResult(
            success=False,
            message=f"兩種更新方式都失敗。\ngit: {git_result.message}\ntarball: {e}",
        )


# ============================================================
# 重啟進程
# ============================================================


async def restart_process(delay: float = 2.0) -> None:
    """
    重啟進程（非阻塞方式）。

    使用 asyncio.create_task 排程延遲重啟，
    讓呼叫端可以先回覆 Telegram 訊息。

    重啟方式：os.execv 直接替換當前進程。
    """
    logger.info("[updater] 將在 %.1f 秒後重啟...", delay)

    async def _do_restart():
        await asyncio.sleep(delay)

        # 刷新使用量佇列，避免資料遺失
        try:
            from db import database
            await database._flush_usage_queue()
        except Exception as e:
            logger.error("[updater] 刷新使用量佇列失敗：%s", e)

        logger.info("[updater] 正在重啟進程...")
        os.execv(sys.executable, [sys.executable] + sys.argv)

    asyncio.create_task(_do_restart())
