"""Local image upscaling: Real-ESRGAN (ncnn-vulkan) on GPU, Pillow Lanczos on CPU."""

import base64
import json
import os
import re
import struct
import subprocess
import tempfile
import time
from pathlib import Path

from config import BASE_DIR, UPSCALER_EXE

# Tile size for the ncnn engine. Smaller tiles = less VRAM; large tiles on
# small GPUs produce corrupted output (garbage from other images overlaid).
DEFAULT_TILE = 256

from config import BASE_DIR, UPSCALER_EXE

DEFAULT_EXE = BASE_DIR / "tools" / "realesrgan" / "realesrgan-ncnn-vulkan.exe"
_TOOLS_DIR = BASE_DIR / "tools" / "realesrgan"
_CACHE_FILE = _TOOLS_DIR / "device_cache.json"
_PROBE_PNG = _TOOLS_DIR / "_probe.png"
_PROBE_OUT = _TOOLS_DIR / "_probe_out.png"
_NOT_INSTALLED = (
    "Upscaler engine not installed. Extract realesrgan-ncnn-vulkan to "
    "backend/tools/realesrgan/ (or set UPSCALER_EXE in .env)."
)

_PROBE_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR4"
    "2mNk+M9Qz4AFmBiY/IYAABnAA4FXK0mMAAAAAElFTkSuQmCC"
)

_RECACHE_AFTER_SECONDS = 3600


def exe_path() -> Path:
    override = UPSCALER_EXE.strip()
    return Path(override) if override else DEFAULT_EXE


def is_available() -> bool:
    return exe_path().exists()


def info() -> dict:
    cache = _load_cache()
    return {
        "available": is_available(),
        "exe": str(exe_path()),
        "device": cache.get("name", "auto-detect on first use"),
        "device_kind": cache.get("kind", "auto"),
    }


def png_dimensions(path: Path) -> tuple[int, int]:
    with open(path, "rb") as f:
        header = f.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError("Not a PNG file")
    width, height = struct.unpack(">II", header[16:24])
    return width, height


def _image_dimensions(path: Path) -> tuple[int, int]:
    try:
        return png_dimensions(path)
    except Exception:
        from PIL import Image

        with Image.open(path) as img:
            return img.size


def classify_size(width: int, height: int) -> str:
    long_side = max(width, height)
    if long_side >= 3800:
        return "4K"
    if long_side >= 1900:
        return "2K"
    return "1K"


def _load_cache() -> dict:
    try:
        return json.loads(_CACHE_FILE.read_text())
    except Exception:
        return {}


def _save_cache(data: dict) -> None:
    try:
        _TOOLS_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE_FILE.write_text(json.dumps(data))
    except Exception:
        pass


def _icd_env() -> dict:
    """Point the Vulkan loader at locally written ICD files (NVIDIA + Intel)."""
    files = [
        str(f)
        for f in sorted(_TOOLS_DIR.glob("*.json"))
        if f.name != "device_cache.json"
    ]
    if not files:
        return {}
    value = ";".join(files)
    return {"VK_DRIVER_FILES": value, "VK_ICD_FILENAMES": value}


def _tile_size() -> int:
    override = os.getenv("UPSCALER_TILE", "").strip()
    if override.isdigit() and int(override) > 0:
        return int(override)
    return DEFAULT_TILE


def _flatten_to_rgb(src: Path, work_dir: Path) -> Path:
    """Re-encode as plain RGB PNG - the engine corrupts alpha-channel inputs."""
    from PIL import Image

    out = work_dir / f"rgb_{src.stem}_{int(time.time())}.png"
    with Image.open(src) as img:
        img.convert("RGB").save(out, "PNG")
    return out


def _run(exe: Path, src: Path, dst: Path, gpu: int | None):
    """Run the engine at its native 4x (always-clean path on this setup)."""
    cmd = [
        str(exe),
        "-i",
        str(src),
        "-o",
        str(dst),
        "-n",
        "realesrgan-x4plus",
        "-s",
        "4",
        "-t",
        str(_tile_size()),
        "-f",
        "png",
    ]
    if gpu is not None:
        cmd += ["-g", str(gpu)]
    env = os.environ.copy()
    env.update(_icd_env())
    return subprocess.run(cmd, capture_output=True, text=True, timeout=1800, env=env)


def _device_name(result, gpu: int | None) -> str:
    text = f"{result.stdout}\n{result.stderr}"
    if gpu is not None:
        matches = re.findall(rf"\[{gpu}\s+([^\]]+)\]", text)
        if matches:
            return matches[0].strip()
    matches = re.findall(r"\[\d+\s+([^\]]+)\]", text)
    return matches[-1].strip() if matches else "Vulkan device"


def _content_ok(src: Path, out_path: Path, factor: int, threshold: float = 60.0) -> bool:
    """Reject engine output whose downscaled content doesn't match the source.

    Corrupt GPU tiles (VRAM overruns, driver fence errors) produce output that
    looks nothing like the input - detect that by mean absolute deviation.
    """
    from PIL import Image

    try:
        source = Image.open(src).convert("RGB")
        output = Image.open(out_path).convert("RGB")
        if output.width < source.width or output.height < source.height:
            return False
        matched = output.resize(source.size, Image.LANCZOS)
        a = list(source.resize((64, 64)).getdata())
        b = list(matched.resize((64, 64)).getdata())
        flat_a = [c for p in a for c in p]
        flat_b = [c for p in b for c in p]
        mad = sum(abs(x - y) for x, y in zip(flat_a, flat_b)) / len(flat_a)
        _ = factor
        return mad <= threshold
    except Exception:
        return False


def _probe_devices(exe: Path) -> dict[int, str]:
    """Probe Vulkan device indices 0..5; return {index: device_name} for working ones."""
    _PROBE_PNG.write_bytes(base64.b64decode(_PROBE_PNG_B64))
    devices: dict[int, str] = {}
    for idx in range(6):
        if _PROBE_OUT.exists():
            _PROBE_OUT.unlink()
        try:
            result = _run(exe, _PROBE_PNG, _PROBE_OUT, idx)
            if _PROBE_OUT.exists() and _content_ok(_PROBE_PNG, _PROBE_OUT, 4):
                devices[idx] = _device_name(result, idx)
        except Exception:
            continue
    if _PROBE_OUT.exists():
        _PROBE_OUT.unlink()
    return devices


def _pick_gpu(exe: Path) -> int | None:
    """Pick a GPU index (NVIDIA first). Returns None when no Vulkan GPU works."""
    devices = _probe_devices(exe)
    if not devices:
        _save_cache({"device": "cpu", "name": "Pillow Lanczos (CPU)", "kind": "cpu", "ts": time.time()})
        return None
    nvidia = next((i for i, n in devices.items() if "nvidia" in n.lower()), None)
    chosen = nvidia if nvidia is not None else min(devices)
    kind = "nvidia" if nvidia is not None else "vulkan"
    _save_cache({"device": chosen, "name": devices[chosen], "kind": kind, "ts": time.time()})
    return chosen


def _cached_gpu(exe: Path) -> int | None:
    cache = _load_cache()
    if not cache:
        return _pick_gpu(exe)
    device = cache.get("device")
    if device is None or isinstance(device, str):
        # Cached as CPU (or unknown) - re-probe occasionally in case a GPU appeared
        if time.time() - cache.get("ts", 0) > _RECACHE_AFTER_SECONDS:
            return _pick_gpu(exe)
        return None
    return int(device)


def _pillow_upscale(src: Path, dst: Path, scale: int) -> tuple[int, int]:
    from PIL import Image

    with Image.open(src) as img:
        result = img.convert("RGB").resize(
            (img.width * scale, img.height * scale), Image.LANCZOS
        )
        dst.parent.mkdir(parents=True, exist_ok=True)
        result.save(dst, "PNG")
    return png_dimensions(dst)


def upscale(src: Path, dst: Path, scale: int) -> tuple[int, int]:
    """Upscale src -> dst (PNG): NVIDIA GPU preferred, then any Vulkan GPU, then CPU.

    The engine always runs at its native 4x (the -s 2 path produces corrupt
    tiles on this setup); a 2x request downscales the 4x result with Lanczos.
    """
    exe = exe_path()
    if not exe.exists():
        raise RuntimeError(_NOT_INSTALLED)
    scale = int(scale)
    if scale not in (2, 4):
        raise ValueError("Scale must be 2 or 4")
    width, height = _image_dimensions(src)
    if classify_size(width, height) == "4K":
        raise ValueError("Source is already 4K resolution")

    dst.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="renderly_upscale_") as tmp:
        flat = _flatten_to_rgb(src, Path(tmp))
        out_tmp = Path(tmp) / "engine_out.png"

        gpu = _cached_gpu(exe)
        if gpu is None:
            gpu = _pick_gpu(exe)

        candidates: list[int | None] = []
        if gpu is not None:
            candidates.append(gpu)
        candidates.append(None)  # engine's own auto device choice as second chance

        for candidate in candidates:
            try:
                result = _run(exe, flat, out_tmp, candidate)
                if not out_tmp.exists():
                    raise RuntimeError("engine produced no output")
                if not _content_ok(flat, out_tmp, 4):
                    # Garbage tiles (VRAM overrun etc.) - reject this device
                    if candidate is not None:
                        try:
                            _CACHE_FILE.unlink()
                        except Exception:
                            pass
                    continue

                from PIL import Image

                with Image.open(out_tmp) as img:
                    if scale == 4:
                        img.convert("RGB").save(dst, "PNG")
                    else:
                        down = img.convert("RGB").resize(
                            (img.width // 2, img.height // 2), Image.LANCZOS
                        )
                        down.save(dst, "PNG")
                if candidate is not None:
                    cache = _load_cache()
                    if cache.get("device") != candidate:
                        _save_cache(
                            {
                                "device": candidate,
                                "name": _device_name(result, candidate),
                                "kind": cache.get("kind", "vulkan"),
                                "ts": time.time(),
                            }
                        )
                return png_dimensions(dst)
            except ValueError:
                raise
            except Exception:
                pass
            if candidate is not None:
                try:
                    _CACHE_FILE.unlink()
                except Exception:
                    pass

    # No working GPU - CPU fallback
    dims = _pillow_upscale(src, dst, scale)
    _save_cache({"device": "cpu", "name": "Pillow Lanczos (CPU)", "kind": "cpu", "ts": time.time()})
    return dims


def engine_label(scale: int) -> str:
    cache = _load_cache()
    if cache.get("kind") == "cpu":
        return f"lanczos (cpu, {scale}x)"
    return f"realesrgan-x4 ({cache.get('name', 'GPU')}, {scale}x)"
