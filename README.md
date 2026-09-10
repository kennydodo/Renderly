# Rosterly

Per-channel AI image generation studio: upload reference assets to a channel, generate single or batch images with Google Gemini, and browse full generation history.

- **Backend** — FastAPI + SQLAlchemy (SQLite), serves generated/uploaded images from `backend/storage/{channel_id}/`
- **Frontend** — React 18 + Vite, dev-proxied to the backend

## Project layout

```
Rosterly/
├── backend/
│   ├── main.py                 # FastAPI app entrypoint
│   ├── config.py               # API key loading, settings
│   ├── db.py                   # SQLite connection/models
│   ├── models/                 # channel, asset, generation tables
│   ├── routes/                 # channels, assets, generate endpoints
│   ├── services/gemini_client.py
│   ├── storage/                # generated + uploaded images on disk
│   ├── requirements.txt
│   └── .env                    # GEMINI_API_KEY (gitignored)
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── pages/              # ChannelList, ChannelWorkspace, History, Settings
│   │   ├── components/         # AssetPicker, PromptForm, BatchGenerateForm, ImageCard, …
│   │   └── api/client.js
│   ├── package.json
│   └── vite.config.js
├── extension/                  # Chrome MV3 extension bridging Google Flow → Rosterly
├── start.bat / stop.bat        # One-click app launch / shutdown
├── .gitignore
└── README.md
```

## Setup

### 1. Backend

```powershell
cd D:\Repos\Rosterly\backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Put your Gemini API key in `backend/.env` (get one at https://aistudio.google.com/apikey):

```
GEMINI_API_KEY=your-key-here
```

Run the API (creates `rosterly.db` and `storage/` automatically):

```powershell
uvicorn main:app --reload --port 8022
```

API is at http://127.0.0.1:8022, interactive docs at http://127.0.0.1:8022/docs.

### 2. Frontend

```powershell
cd D:\Repos\Rosterly\frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/storage` to the backend.

## API summary

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/api/channels` | List / create channels |
| GET/PATCH/DELETE | `/api/channels/{id}` | Get / update / delete channel (removes its files) |
| GET | `/api/channels/{id}/export` | Download all generated images as a zip |
| GET/POST | `/api/channels/{id}/assets` | List / upload channel assets (png, jpeg, webp; ≤10 MB) |
| DELETE | `/api/assets/{id}` | Delete an asset |
| GET/POST | `/api/channels/{id}/templates` | List / save reusable master prompts for the channel |
| DELETE | `/api/templates/{id}` | Delete a template |
| POST | `/api/channels/{id}/generate` | Single generation `{ prompt, asset_ids?, generation_ids?, aspect_ratio? ("16:9" default), ref_strength? }` |
| POST | `/api/channels/{id}/generate/batch` | Batch `{ items: [{ prompt, asset_ids?, generation_ids? }], asset_ids?, generation_ids?, aspect_ratio?, ref_strength?, parallel? }` — item refs override the main refs; rows without refs use the main ones |
| POST | `/api/generations/{id}/regenerate` | Re-run a generation with its stored prompt, refs, ratio and strength |
| PATCH | `/api/generations/{id}` | Rename a generation |
| POST | `/api/generations/{id}/save-as-asset` | Copy a generated image into a channel's assets |
| GET | `/api/generations?channel_id=&search=&date_from=&date_to=&status=&limit=` | Generation history (search matches name or prompt) |
| GET | `/api/generations/{id}` | One generation |

Images are served at `/storage/{channel_id}/{filename}.png`.

## Notes

- The image model defaults to `gemini-3.1-flash-image` (nano banana 2); override with `GEMINI_IMAGE_MODEL` in `.env`.
- Aspect ratios: `1:1`, `16:9` (default), `9:16`, `4:3`, `3:4`.
- Resolutions: `1K` (default, 1376×768 at 16:9), `2K` (2752×1536), `4K` (5504×3072).
- Reference adherence presets: **Balanced** (default, no extra instruction), **Loose** (refs are loose inspiration), **Strict** (reproduce refs as faithfully as possible).
- Batches have **no item limit** — add as many prompts as you like. They run sequentially by default; tick **Parallel** to run up to 4 prompts concurrently (faster, uses quota faster too).
- New generations are auto-named from the first words of the prompt; click the name in a gallery card to rename.
- One-click launch: run `start.bat` (double-click) to open backend + frontend in their own windows; `stop.bat` shuts them down.
