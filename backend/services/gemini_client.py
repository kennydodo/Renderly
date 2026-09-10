"""Thin wrapper around the google-genai SDK for image generation."""

import logging
import time

from google import genai
from google.genai import types

from config import GEMINI_API_KEY, GEMINI_IMAGE_MODEL

logger = logging.getLogger(__name__)

_client: genai.Client | None = None

MAX_ATTEMPTS = 3


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not GEMINI_API_KEY:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Add it to backend/.env "
                "(get a key at https://aistudio.google.com/apikey)."
            )
        _client = genai.Client(api_key=GEMINI_API_KEY)
    return _client


def _is_rate_limit(exc: Exception) -> bool:
    text = str(exc).lower()
    code = getattr(exc, "code", None)
    return "429" in text or "resource_exhausted" in text or "rate limit" in text or code == 429


def _retry_delay(exc: Exception, attempt: int) -> float:
    # Honor Google's suggested delay when present, else exponential backoff.
    text = str(exc)
    marker = "retry in"
    idx = text.lower().find(marker)
    if idx != -1:
        tail = text[idx + len(marker):].strip().split()
        if tail:
            try:
                return max(1.0, min(60.0, float(tail[0].rstrip("s"))))
            except ValueError:
                pass
    return 2.0 * (2 ** attempt)


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not GEMINI_API_KEY:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Add it to backend/.env "
                "(get a key at https://aistudio.google.com/apikey)."
            )
        _client = genai.Client(api_key=GEMINI_API_KEY)
    return _client


def generate_image(
    prompt: str,
    reference_images: list[tuple[bytes, str]] | None = None,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
) -> bytes:
    """Generate one image and return the raw image bytes.

    reference_images: optional list of (data, mime_type) tuples used as
    subject/style references for the model.
    aspect_ratio: optional "1:1", "16:9", "9:16", "4:3", "3:4".
    image_size: optional "1K", "2K", "4K".
    """
    client = get_client()

    contents: list = [prompt]
    for data, mime_type in reference_images or []:
        contents.append(types.Part.from_bytes(data=data, mime_type=mime_type))

    image_config_kwargs = {}
    if aspect_ratio:
        image_config_kwargs["aspect_ratio"] = aspect_ratio
    if image_size:
        image_config_kwargs["image_size"] = image_size

    config = None
    if image_config_kwargs:
        config = types.GenerateContentConfig(
            image_config=types.ImageConfig(**image_config_kwargs)
        )

    response = None
    last_exc: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            response = client.models.generate_content(
                model=GEMINI_IMAGE_MODEL,
                contents=contents,
                config=config,
            )
            break
        except Exception as exc:  # noqa: BLE001 - retry transient rate limits
            if not _is_rate_limit(exc) or attempt == MAX_ATTEMPTS - 1:
                raise
            delay = _retry_delay(exc, attempt)
            logger.warning("Rate limited, retrying in %.1fs (attempt %d)", delay, attempt + 1)
            time.sleep(delay)
            last_exc = exc

    if response is None:
        raise last_exc or RuntimeError("Image generation failed")

    for part in response.parts:
        inline = getattr(part, "inline_data", None)
        if inline and inline.data:
            return inline.data

    text = getattr(response, "text", None)
    raise RuntimeError(f"Model returned no image data: {text or 'empty response'}")
