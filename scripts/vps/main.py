"""
AccessBridge API — derives /version from the deployed extension zip.

No hardcoded CURRENT_VERSION. The version is read from manifest.json
*inside* /docs/downloads/accessbridge-extension.zip on first request,
then cached and invalidated by the zip's mtime. The changelog comes
from the top v* section of /docs/CHANGELOG.md.

So pushing a new zip + CHANGELOG.md to the VPS is the only action
needed to update the /api/version response — no code change, no
container restart.

Mount requirement (docker-compose.yml, accessbridge-api service):
  volumes:
    - ./api:/app
    - ./docs:/docs:ro     # <-- required for this module to find the zip
"""
import json
import re
import zipfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import uvicorn

ZIP_PATH = Path("/docs/downloads/accessbridge-extension.zip")
CHANGELOG_PATH = Path("/docs/CHANGELOG.md")
DOWNLOAD_BASE = "https://accessbridge.space"
DOWNLOAD_URL = "/downloads/accessbridge-extension.zip"

app = FastAPI(title="AccessBridge API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cache keyed by (zip_mtime, changelog_mtime). Served stale-on-error.
_cache = {"key": None, "data": None}


def _extract_latest_section(markdown: str) -> str:
    """Return the body of the first `## vX.Y.Z …` section (without header).
    Strips `###` sub-headers but keeps bullets. Caps at 500 chars."""
    match = re.search(
        r"^##\s+v[\d.]+[^\n]*\n(.*?)(?=^##\s+v|\Z)",
        markdown,
        re.MULTILINE | re.DOTALL,
    )
    if not match:
        return ""
    body = match.group(1)
    kept = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("###"):
            continue
        kept.append(stripped)
    joined = "\n".join(kept)
    return joined[:500]


def _read_version_info() -> dict:
    """Derived version + changelog with mtime-keyed caching."""
    try:
        zip_mtime = ZIP_PATH.stat().st_mtime
        changelog_mtime = (
            CHANGELOG_PATH.stat().st_mtime if CHANGELOG_PATH.exists() else 0.0
        )
        key = (zip_mtime, changelog_mtime)
        if _cache["key"] == key and _cache["data"] is not None:
            return _cache["data"]

        with zipfile.ZipFile(ZIP_PATH) as z:
            with z.open("manifest.json") as f:
                manifest = json.load(f)
        version = manifest.get("version", "0.0.0")

        changelog = ""
        if CHANGELOG_PATH.exists():
            changelog = _extract_latest_section(CHANGELOG_PATH.read_text())

        data = {
            "version": version,
            "download_url": DOWNLOAD_URL,
            "changelog": changelog or f"Release v{version}",
        }
        _cache["key"] = key
        _cache["data"] = data
        return data
    except Exception as exc:
        if _cache["data"]:
            # Serve last good data so the extension's update banner keeps working
            return _cache["data"]
        return {
            "version": "unknown",
            "download_url": DOWNLOAD_URL,
            "changelog": f"Unable to read version: {type(exc).__name__}",
            "error": str(exc),
        }


@app.get("/health")
def health():
    info = _read_version_info()
    return {"status": "ok", "service": "accessbridge-api", "version": info["version"]}


@app.get("/")
def root():
    info = _read_version_info()
    return {"name": "AccessBridge API", "version": info["version"], "docs": "/docs"}


@app.get("/version")
def version():
    return _read_version_info()


@app.get("/updates.xml")
def updates_xml():
    info = _read_version_info()
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="{{appid}}">
    <updatecheck codebase="{DOWNLOAD_BASE}{DOWNLOAD_URL}" version="{info['version']}" />
  </app>
</gupdate>"""
    return Response(content=xml, media_type="application/xml")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8100)
