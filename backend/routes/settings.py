from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db import get_db
from models import AppSetting

router = APIRouter(prefix="/api", tags=["settings"])

DEFAULTS = {"upscale_level": "4", "auto_download": "1", "download_dir": ""}


def get_setting(db: Session, key: str) -> str:
    row = db.get(AppSetting, key)
    return row.value if row else DEFAULTS.get(key, "")


def auto_process_settings(db: Session) -> tuple[int, bool, str]:
    """(upscale_level, auto_download, download_dir) for finished generations."""
    try:
        level = max(0, min(4, int(get_setting(db, "upscale_level") or 0)))
    except ValueError:
        level = 0
    return level, get_setting(db, "auto_download") != "0", get_setting(db, "download_dir")


class SettingsUpdate(BaseModel):
    upscale_level: int | None = None
    auto_download: bool | None = None
    download_dir: str | None = None


@router.get("/settings")
def read_settings(db: Session = Depends(get_db)):
    try:
        level = max(0, min(4, int(get_setting(db, "upscale_level") or 0)))
    except ValueError:
        level = 0
    return {
        "upscale_level": level,
        "auto_download": get_setting(db, "auto_download") != "0",
        "download_dir": get_setting(db, "download_dir"),
    }


@router.put("/settings")
def update_settings(body: SettingsUpdate, db: Session = Depends(get_db)):
    updates = {}
    if body.upscale_level is not None:
        updates["upscale_level"] = str(max(0, min(4, int(body.upscale_level))))
    if body.auto_download is not None:
        updates["auto_download"] = "1" if body.auto_download else "0"
    if body.download_dir is not None:
        updates["download_dir"] = body.download_dir.strip()
    for key, value in updates.items():
        row = db.get(AppSetting, key)
        if row is None:
            db.add(AppSetting(key=key, value=value))
        else:
            row.value = value
    db.commit()
    return read_settings(db)
