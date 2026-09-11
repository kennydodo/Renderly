import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent

# On-disk storage for uploaded + generated images, organized per channel
STORAGE_DIR = BASE_DIR / "storage"
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_IMAGE_MODEL = os.getenv("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")

ASPECT_RATIOS = ("1:1", "16:9", "9:16", "4:3", "3:4")
DEFAULT_ASPECT_RATIO = "16:9"
REF_STRENGTHS = ("loose", "balanced", "strict")

# Image resolution tiers accepted by the model and their USD price per image.
IMAGE_SIZES = ("1K", "2K", "4K")
DEFAULT_IMAGE_SIZE = "1K"
IMAGE_PRICE_USD = {
    "1K": float(os.getenv("GEMINI_IMAGE_PRICE_1K_USD", "0.039")),
    "2K": float(os.getenv("GEMINI_IMAGE_PRICE_2K_USD", "0.078")),
    "4K": float(os.getenv("GEMINI_IMAGE_PRICE_4K_USD", "0.156")),
}

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{(BASE_DIR / 'renderly.db').as_posix()}")

MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10 MB

# Local upscaler (Real-ESRGAN ncnn-vulkan). Extracted under backend/tools/realesrgan
# or point UPSCALER_EXE in .env at the executable.
UPSCALER_EXE = os.getenv("UPSCALER_EXE", "")
MAX_BATCH_PROMPTS = 10
