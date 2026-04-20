"""
iCloud Downloader - Backend Flask + Socket.IO
"""
import os
import re
import threading
import time
import hashlib
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, jsonify, request, Response, stream_with_context
from flask_socketio import SocketIO

app = Flask(__name__)
app.config["SECRET_KEY"] = os.urandom(24).hex()
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ── Global state ──────────────────────────────────────────────────────────────

g = {
    "service": None,
    "authenticated": False,
    "username": None,
}

photo_cache: dict = {}   # id -> pyicloud PhotoAsset object

dl = {
    "active": False,
    "cancelled": False,
    "thread": None,
    "files": {},           # id -> file_info dict
    "stats": {
        "total_files": 0,
        "completed": 0,
        "failed": 0,
        "total_bytes": 0,
        "downloaded_bytes": 0,
        "start_time": None,
        "speed": 0.0,
        "eta": 0.0,
        "output_dir": "",
        "delete_after": False,
    },
}

_lock = threading.Lock()


# ── Helpers ───────────────────────────────────────────────────────────────────

def win_to_linux(path: str) -> str:
    """Convert Windows path (d:\\fotos\\...) to WSL path (/mnt/d/fotos/...)."""
    if len(path) >= 2 and path[1] == ":":
        drive = path[0].lower()
        rest = path[2:].replace("\\", "/")
        return f"/mnt/{drive}{rest}"
    return path.replace("\\", "/")


def format_bytes(b: int) -> str:
    if b == 0:
        return "0 B"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.2f} {unit}"
        b /= 1024
    return f"{b:.2f} PB"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    email = data.get("email", "").strip()
    password = data.get("password", "")
    if not email or not password:
        return jsonify({"error": "Se requiere email y contraseña"}), 400

    try:
        from pyicloud import PyiCloudService
        svc = PyiCloudService(email, password)
        g["service"] = svc
        g["username"] = email

        if svc.requires_2fa:
            return jsonify({"status": "2fa_required"})
        if getattr(svc, "requires_2sa", False):
            return jsonify({"status": "2fa_required"})

        g["authenticated"] = True
        return jsonify({"status": "ok", "username": email})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 401


@app.route("/api/verify_2fa", methods=["POST"])
def api_verify_2fa():
    code = (request.get_json() or {}).get("code", "").strip()
    svc = g.get("service")
    if not svc:
        return jsonify({"error": "No autenticado"}), 401
    try:
        result = svc.validate_2fa_code(code)
        if not result:
            return jsonify({"error": "Código incorrecto"}), 400
        if not getattr(svc, "is_trusted_session", True):
            svc.trust_session()
        g["authenticated"] = True
        return jsonify({"status": "ok", "username": g["username"]})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/logout", methods=["POST"])
def api_logout():
    g.update({"service": None, "authenticated": False, "username": None})
    photo_cache.clear()
    return jsonify({"status": "ok"})


# ── Storage stats ─────────────────────────────────────────────────────────────

@app.route("/api/storage")
def api_storage():
    svc = g.get("service")
    if not svc:
        return jsonify({"error": "No autenticado"}), 401
    try:
        raw = svc.account.storage.usage_data
        # Normalise to a predictable shape
        su = raw.get("storageUsage", raw)
        used  = su.get("usedStorageInBytes",      su.get("used",  0))
        total = su.get("totalStorageInBytes",     su.get("total", 0))
        avail = su.get("availableStorageInBytes", total - used)
        return jsonify({
            "used": used,
            "total": total,
            "available": avail,
            "used_fmt": format_bytes(used),
            "total_fmt": format_bytes(total),
            "available_fmt": format_bytes(avail),
            "percent": round(used / total * 100, 1) if total else 0,
        })
    except Exception as exc:
        return jsonify({"error": str(exc), "used": 0, "total": 0, "available": 0})


# ── Album streaming state ──────────────────────────────────────────────────────

SHARED_PREFIX = "shared:"

_album_load = {"active": False, "cancelled": False, "album": None}


def _find_album_source(svc, album_name):
    """Return the pyicloud album/source object for album_name, or None."""
    if album_name in ("All Photos", "__all__"):
        return svc.photos.all
    if album_name.startswith(SHARED_PREFIX):
        real_name = album_name[len(SHARED_PREFIX):]
        for a in svc.photos.shared_streams:
            try:
                if a.title == real_name:
                    return a
            except Exception:
                continue
        return None
    for a in svc.photos.albums:
        try:
            if a.title == album_name:
                return a
        except Exception:
            continue
    return None


@app.route("/api/album/cancel_load", methods=["POST"])
def api_cancel_album_load():
    _album_load["cancelled"] = True
    return jsonify({"status": "ok"})


@app.route("/api/album/<path:album_name>/stream", methods=["POST"])
def api_album_stream(album_name):
    svc = g.get("service")
    if not svc:
        return jsonify({"error": "No autenticado"}), 401
    try:
        source = _find_album_source(svc, album_name)
        if source is None:
            return jsonify({"error": "Álbum no encontrado"}), 404
        try:
            total = len(source)
        except Exception:
            total = 0

        # Cancel any running load
        _album_load["cancelled"] = True
        time.sleep(0.15)
        _album_load.update({"cancelled": False, "active": True, "album": album_name})

        threading.Thread(
            target=_album_load_worker,
            args=(album_name, source, total),
            daemon=True,
        ).start()

        return jsonify({"status": "loading", "total": total})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


def _album_load_worker(album_name, source, total):
    batch = []
    loaded = 0
    try:
        for photo in source:
            if _album_load["cancelled"] or _album_load["album"] != album_name:
                return
            photo_cache[photo.id] = photo
            try:
                orig = photo.versions.get("original") or next(iter(photo.versions.values()), {})
                size = orig.get("size", 0) or 0
                mtype = orig.get("type", "")
                # Normalizar UTI a MIME si es necesario
                if mtype and "/" not in mtype:
                    uti_map = {
                        "public.jpeg": "image/jpeg", "public.png": "image/png",
                        "public.heic": "image/heic", "public.heif": "image/heif",
                        "public.tiff": "image/tiff", "public.gif": "image/gif",
                        "com.apple.quicktime-movie": "video/quicktime",
                        "public.mpeg-4": "video/mp4", "public.avi": "video/avi",
                    }
                    mtype = uti_map.get(mtype.lower(), "image/jpeg")
            except Exception:
                size, mtype = 0, ""
            # Obtener fecha con fallbacks
            date_str = None
            for attr in ("asset_date", "created", "added_date"):
                try:
                    val = getattr(photo, attr, None)
                    if val and hasattr(val, "isoformat"):
                        date_str = val.isoformat()
                        break
                except Exception:
                    pass
            batch.append({
                "id": photo.id,
                "filename": photo.filename,
                "date": date_str,
                "size": size,
                "size_fmt": format_bytes(size),
                "media_type": mtype,
                "album": album_name,
            })
            loaded += 1
            if len(batch) >= 50:
                socketio.emit("album_photos_batch", {
                    "album": album_name, "photos": batch,
                    "loaded": loaded, "total": total,
                })
                batch = []
        if batch:
            socketio.emit("album_photos_batch", {
                "album": album_name, "photos": batch,
                "loaded": loaded, "total": total,
            })
        socketio.emit("album_loading_done", {"album": album_name, "total": loaded})
    except Exception as exc:
        socketio.emit("album_loading_error", {"album": album_name, "error": str(exc)})
    finally:
        if _album_load["album"] == album_name:
            _album_load["active"] = False


# ── Photo preview ─────────────────────────────────────────────────────────────

def _is_heic(ctype: str, filename: str) -> bool:
    ct = ctype.lower()
    fn = filename.lower()
    return ("heic" in ct or "heif" in ct or
            fn.endswith(".heic") or fn.endswith(".heif"))


def _convert_heic_to_jpeg(data: bytes) -> bytes:
    import io
    import pillow_heif
    from PIL import Image
    pillow_heif.register_heif_opener()
    img = Image.open(io.BytesIO(data))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


@app.route("/api/photo/<photo_id>/preview")
def api_photo_preview(photo_id):
    photo = photo_cache.get(photo_id)
    if not photo:
        return jsonify({"error": "Foto no encontrada en caché. Abre el álbum primero."}), 404
    try:
        orig = photo.versions.get("original") or {}
        is_video = (orig.get("type", "")).startswith("video/")
        version_order = ("original",) if is_video else ("medium", "thumb", "original")
        errors = []
        for v in version_order:
            try:
                resp = photo.download(v)
                if resp is None:
                    errors.append(f"{v}: versión no disponible")
                    continue
                # pyicloud puede devolver bytes directamente o un requests.Response
                if isinstance(resp, (bytes, bytearray)):
                    data = bytes(resp)
                elif hasattr(resp, "status_code"):
                    if resp.status_code != 200:
                        errors.append(f"{v}: HTTP {resp.status_code}")
                        continue
                    data = resp.content
                else:
                    errors.append(f"{v}: tipo inesperado {type(resp).__name__}")
                    continue
                if not data:
                    errors.append(f"{v}: datos vacíos")
                    continue
                ctype = (photo.versions.get(v) or orig).get("type", "image/jpeg")
                if _is_heic(ctype, photo.filename):
                    data  = _convert_heic_to_jpeg(data)
                    ctype = "image/jpeg"
                return Response(data, content_type=ctype,
                                headers={"Cache-Control": "private, max-age=3600"})
            except Exception as e:
                errors.append(f"{v}: {e}")
                continue
        return jsonify({"error": f"No se pudo obtener la previsualización. Detalles: {'; '.join(errors)}"}), 500
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/photo/<photo_id>/delete", methods=["POST"])
def api_photo_delete(photo_id):
    photo = photo_cache.get(photo_id)
    if not photo:
        return jsonify({"error": "Foto no encontrada en caché"}), 404
    try:
        photo.delete()
        photo_cache.pop(photo_id, None)
        return jsonify({"status": "deleted"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/album/<path:album_name>/delete_photos", methods=["POST"])
def api_album_delete_photos(album_name):
    svc = g.get("service")
    if not svc:
        return jsonify({"error": "No autenticado"}), 401
    try:
        source = _find_album_source(svc, album_name)
        if source is None:
            return jsonify({"error": "Álbum no encontrado"}), 404
        deleted, errors = 0, []
        for photo in source:
            try:
                photo.delete()
                photo_cache.pop(photo.id, None)
                deleted += 1
            except Exception as e:
                errors.append(str(e))
        # Delete the album container itself
        album_deleted = False
        album_delete_error = None
        try:
            result = source.delete()
            album_deleted = bool(result)
        except NotImplementedError:
            album_delete_error = "El álbum no se puede eliminar (álbum inteligente o compartido)"
        except Exception as e:
            album_delete_error = str(e)
        return jsonify({
            "deleted": deleted,
            "errors": errors[:5],
            "album_deleted": album_deleted,
            "album_delete_error": album_delete_error,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Albums ────────────────────────────────────────────────────────────────────

def _albums_sort_key(a):
    if a["name"] in ("Library", "All Photos", "Todas las fotos"):
        return (0, a["name"])
    if a.get("shared"):
        return (2, a.get("display_name", a["name"]))
    return (1, a["name"])


def _albums_load_worker(svc):
    """Carga álbumes en background emitiendo progreso por Socket.IO."""
    try:
        # Recopilar todos los objetos de álbum (rápido, sin contar fotos aún)
        pairs = []  # (tipo, nombre, objeto)
        for album in svc.photos.albums:
            try:
                pairs.append(("normal", album.title, album))
            except Exception:
                continue
        try:
            for album in svc.photos.shared_streams:
                try:
                    pairs.append(("shared", album.title, album))
                except Exception:
                    continue
        except Exception:
            pass

        total = len(pairs)
        socketio.emit("albums_start", {"total": total})
        start = time.time()

        results = []
        for i, (atype, name, album) in enumerate(pairs):
            try:
                count = len(album)
            except Exception:
                count = 0

            entry = {
                "name":         SHARED_PREFIX + name if atype == "shared" else name,
                "display_name": name if atype == "shared" else None,
                "count":        count,
                "shared":       atype == "shared",
                "position":     i,   # original order from iCloud API (= iPhone order)
            }
            results.append(entry)

            loaded  = i + 1
            elapsed = time.time() - start
            speed   = loaded / elapsed if elapsed > 0 else 0
            eta     = (total - loaded) / speed if speed > 0 else 0

            socketio.emit("albums_progress", {
                "loaded": loaded,
                "total":  total,
                "pct":    round(loaded / total * 100, 1) if total else 0,
                "eta":    round(eta),
                "album":  entry,
            })

        results.sort(key=_albums_sort_key)
        socketio.emit("albums_done", {"albums": results})

    except Exception as exc:
        socketio.emit("albums_error", {"error": str(exc)})


@app.route("/api/albums/stream", methods=["POST"])
def api_albums_stream():
    svc = g.get("service")
    if not svc:
        return jsonify({"error": "No autenticado"}), 401
    threading.Thread(target=_albums_load_worker, args=(svc,), daemon=True).start()
    return jsonify({"status": "loading"})


@app.route("/api/album/<path:album_name>/photos")
def api_album_photos(album_name):
    svc = g.get("service")
    if not svc:
        return jsonify({"error": "No autenticado"}), 401

    page     = int(request.args.get("page", 1))
    per_page = int(request.args.get("per_page", 200))

    try:
        if album_name in ("All Photos", "__all__"):
            source = svc.photos.all
        elif album_name.startswith(SHARED_PREFIX):
            real_name = album_name[len(SHARED_PREFIX):]
            source = None
            for _album in svc.photos.shared_streams:
                try:
                    if _album.title == real_name:
                        source = _album
                        break
                except Exception:
                    continue
            if source is None:
                return jsonify({"error": "Álbum compartido no encontrado"}), 404
        else:
            source = svc.photos.albums.get(album_name)
            if source is None:
                return jsonify({"error": "Álbum no encontrado"}), 404

        photos = []
        start = (page - 1) * per_page
        end   = start + per_page

        for i, photo in enumerate(source):
            if i < start:
                continue
            if i >= end:
                break

            # Cache for later download
            photo_cache[photo.id] = photo

            try:
                orig = photo.versions.get("original") or next(iter(photo.versions.values()), {})
                size = orig.get("size", 0) or 0
                mtype = orig.get("type", "")
            except Exception:
                size, mtype = 0, ""

            photos.append({
                "id": photo.id,
                "filename": photo.filename,
                "date": photo.asset_date.isoformat() if photo.asset_date else None,
                "size": size,
                "size_fmt": format_bytes(size),
                "media_type": mtype,
                "album": album_name,
            })

        return jsonify({"photos": photos, "page": page, "per_page": per_page})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


# ── Download ──────────────────────────────────────────────────────────────────

@app.route("/api/download/start", methods=["POST"])
def api_download_start():
    if dl["active"]:
        return jsonify({"error": "Ya hay una descarga en curso"}), 409

    data = request.get_json() or {}
    output_dir   = data.get("output_dir", "").strip()
    albums       = data.get("albums", [])
    photo_ids    = data.get("photo_ids", [])
    photo_items  = data.get("photo_items", [])   # [{id, album}]
    all_photos   = data.get("all_photos", False)
    delete_after = data.get("delete_after", False)

    if not output_dir:
        now = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"/mnt/d/fotos/{now}"
    else:
        output_dir = win_to_linux(output_dir)

    t = threading.Thread(
        target=_download_worker,
        args=(albums, photo_ids, photo_items, all_photos, output_dir, delete_after),
        daemon=True,
    )
    dl["cancelled"] = False
    dl["thread"] = t
    t.start()

    return jsonify({"status": "started", "output_dir": output_dir})


@app.route("/api/download/cancel", methods=["POST"])
def api_download_cancel():
    dl["cancelled"] = True
    return jsonify({"status": "cancelling"})


@app.route("/api/download/status")
def api_download_status():
    stats = dict(dl["stats"])
    return jsonify({
        "active": dl["active"],
        "cancelled": dl["cancelled"],
        "stats": stats,
        "files": {
            fid: {k: v for k, v in info.items() if k != "_obj"}
            for fid, info in dl["files"].items()
        },
    })


# ── Download worker ───────────────────────────────────────────────────────────

def _download_worker(albums, photo_ids, photo_items, all_photos, output_dir, delete_after):
    svc = g.get("service")
    dl["active"] = True
    dl["files"] = {}
    dl["stats"].update({
        "total_files": 0,
        "completed": 0,
        "failed": 0,
        "total_bytes": 0,
        "downloaded_bytes": 0,
        "start_time": time.time(),
        "speed": 0.0,
        "eta": 0.0,
        "output_dir": output_dir,
        "delete_after": delete_after,
    })

    try:
        os.makedirs(output_dir, exist_ok=True)
    except Exception as exc:
        socketio.emit("error", {"message": f"No se puede crear el directorio: {exc}"})
        dl["active"] = False
        return

    # ── Collect photos ────────────────────────────────────────────────────────
    # photos_to_dl is a list of (PhotoAsset, subdir_or_None) tuples
    socketio.emit("status", {"message": "Recopilando fotos...", "phase": "collecting"})
    photos_to_dl = []

    try:
        seen = set()
        if all_photos:
            for p in svc.photos.all:
                photo_cache[p.id] = p
                photos_to_dl.append((p, None))
                seen.add(p.id)
        else:
            # Albums (download entire album with subdirectory)
            if albums:
                for album_name in albums:
                    if album_name in ("All Photos", "__all__"):
                        src    = svc.photos.all
                        subdir = None
                    else:
                        src    = _find_album_source(svc, album_name)
                        subdir = album_name
                    if src is None:
                        continue
                    for p in src:
                        if p.id not in seen:
                            photo_cache[p.id] = p
                            photos_to_dl.append((p, subdir))
                            seen.add(p.id)
            # Individual photos (from cache)
            if photo_items:
                for item in photo_items:
                    pid   = item.get("id")
                    album = item.get("album") or None
                    p = photo_cache.get(pid)
                    if p and p.id not in seen:
                        photos_to_dl.append((p, album))
                        seen.add(p.id)
            # Legacy photo_ids fallback
            if photo_ids and not photo_items:
                for pid in photo_ids:
                    p = photo_cache.get(pid)
                    if p and p.id not in seen:
                        photos_to_dl.append((p, None))
                        seen.add(p.id)
    except Exception as exc:
        socketio.emit("error", {"message": f"Error al recopilar fotos: {exc}"})
        dl["active"] = False
        return

    total_files = len(photos_to_dl)
    total_bytes = sum(
        (p.versions.get("original") or {}).get("size", 0) or 0
        for p, _ in photos_to_dl
    )
    dl["stats"]["total_files"] = total_files
    dl["stats"]["total_bytes"] = total_bytes

    socketio.emit("download_start", {
        "total_files": total_files,
        "total_bytes": total_bytes,
        "total_bytes_fmt": format_bytes(total_bytes),
        "output_dir": output_dir,
    })

    # ── Download each file ────────────────────────────────────────────────────
    for idx, (photo, subdir) in enumerate(photos_to_dl):
        if dl["cancelled"]:
            socketio.emit("status", {"message": "Descarga cancelada por el usuario", "phase": "cancelled"})
            break
        _download_one(photo, output_dir, delete_after, idx + 1, total_files, subdir=subdir)

    # ── Final ─────────────────────────────────────────────────────────────────
    stats = dl["stats"]
    socketio.emit("download_complete", {
        "total_files": stats["total_files"],
        "completed": stats["completed"],
        "failed": stats["failed"],
        "output_dir": output_dir,
    })
    dl["active"] = False


_EXT_MAP = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/heic": ".heic", "image/heif": ".heif", "image/tiff": ".tiff",
    "image/gif": ".gif", "image/bmp": ".bmp", "image/webp": ".webp",
    "video/quicktime": ".mov", "video/mp4": ".mp4", "video/mpeg": ".mpeg",
    "video/x-msvideo": ".avi", "video/3gpp": ".3gp",
}

def _ensure_extension(filename: str, versions: dict) -> str:
    """Añade extensión al nombre de fichero si no la tiene."""
    if os.path.splitext(filename)[1]:
        return filename
    orig = versions.get("original") or next(iter(versions.values()), {})
    ctype = (orig.get("type", "") or "").lower()
    # Normalizar UTI a MIME
    if "/" not in ctype:
        uti_map = {
            "public.jpeg": "image/jpeg", "public.png": "image/png",
            "public.heic": "image/heic", "public.heif": "image/heif",
            "public.tiff": "image/tiff", "public.gif": "image/gif",
            "com.apple.quicktime-movie": "video/quicktime",
            "public.mpeg-4": "video/mp4",
        }
        ctype = uti_map.get(ctype, "")
    ext = _EXT_MAP.get(ctype, "")
    return filename + ext if ext else filename


def _download_one(photo, output_dir, delete_after, file_num, total_files, subdir=None):
    fid      = photo.id
    filename = _ensure_extension(photo.filename, photo.versions)

    # Resolve actual directory (create album subdirectory if needed)
    if subdir:
        safe_subdir = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', subdir).strip(". ")
        actual_dir  = os.path.join(output_dir, safe_subdir)
        os.makedirs(actual_dir, exist_ok=True)
    else:
        actual_dir = output_dir

    try:
        orig = photo.versions.get("original") or next(iter(photo.versions.values()), {})
        expected_size = orig.get("size", 0) or 0
        width  = orig.get("width")
        height = orig.get("height")
    except Exception:
        expected_size = 0
        width = height = None

    dl["files"][fid] = {
        "filename": filename,
        "status": "downloading",
        "size": expected_size,
        "width": width,
        "height": height,
        "downloaded": 0,
        "verified": False,
        "error": None,
        "filepath": None,
        "checksum": None,
        "deleted_from_icloud": False,
    }

    socketio.emit("file_start", {
        "id": fid,
        "filename": filename,
        "size": expected_size,
        "size_fmt": format_bytes(expected_size),
        "width": width,
        "height": height,
        "file_num": file_num,
        "total_files": total_files,
    })

    # ── Build output path (handle duplicates) ─────────────────────────────────
    filepath = os.path.join(actual_dir, filename)
    if os.path.exists(filepath):
        base, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(filepath):
            filepath = os.path.join(actual_dir, f"{base}_{counter}{ext}")
            counter += 1

    try:
        response = photo.download("original")
        if response is None:
            raise RuntimeError("sin respuesta (versión original no disponible)")
        # pyicloud puede devolver bytes directamente o un requests.Response
        if isinstance(response, (bytes, bytearray)):
            raw_data = bytes(response)
        elif hasattr(response, "status_code"):
            if response.status_code != 200:
                raise RuntimeError(f"HTTP {response.status_code}")
            raw_data = response.content
        else:
            raise RuntimeError(f"tipo de respuesta inesperado: {type(response).__name__}")

        sha256 = hashlib.sha256()
        downloaded = 0
        last_emit  = 0.0

        with open(filepath, "wb") as fh:
            # Iterar en chunks sobre los bytes para poder emitir progreso
            for i in range(0, len(raw_data), 65536):
                chunk = raw_data[i:i + 65536]
                if dl["cancelled"]:
                    break
                if chunk:
                    fh.write(chunk)
                    sha256.update(chunk)
                    downloaded += len(chunk)

                    with _lock:
                        dl["files"][fid]["downloaded"] = downloaded
                        dl["stats"]["downloaded_bytes"] += len(chunk)

                    now = time.time()
                    if now - last_emit >= 0.25:  # max 4 emits/s per file
                        elapsed  = now - dl["stats"]["start_time"]
                        speed    = dl["stats"]["downloaded_bytes"] / elapsed if elapsed > 0 else 0
                        rem_b    = dl["stats"]["total_bytes"] - dl["stats"]["downloaded_bytes"]
                        eta      = rem_b / speed if speed > 0 else 0

                        dl["stats"]["speed"] = speed
                        dl["stats"]["eta"]   = eta

                        socketio.emit("progress", {
                            "id": fid,
                            "filename": filename,
                            "file_downloaded": downloaded,
                            "file_size": expected_size,
                            "file_pct": round(downloaded / expected_size * 100, 1) if expected_size else 0,
                            "total_downloaded": dl["stats"]["downloaded_bytes"],
                            "total_bytes": dl["stats"]["total_bytes"],
                            "total_pct": round(
                                dl["stats"]["downloaded_bytes"] / dl["stats"]["total_bytes"] * 100, 1
                            ) if dl["stats"]["total_bytes"] else 0,
                            "speed": speed,
                            "speed_fmt": format_bytes(int(speed)) + "/s",
                            "eta": eta,
                            "completed": dl["stats"]["completed"],
                            "total_files": total_files,
                            "file_num": file_num,
                        })
                        last_emit = now

        # ── Cancelled mid-file ────────────────────────────────────────────────
        if dl["cancelled"]:
            if os.path.exists(filepath):
                os.unlink(filepath)
            dl["files"][fid]["status"] = "cancelled"
            return

        # ── Verification ──────────────────────────────────────────────────────
        actual_size = os.path.getsize(filepath)
        checksum    = sha256.hexdigest()
        verified    = True
        verify_error = None

        if expected_size > 0 and actual_size != expected_size:
            verified     = False
            verify_error = f"Tamaño incorrecto: esperado {expected_size:,} B, obtenido {actual_size:,} B"

        dl["files"][fid].update({
            "status": "verified" if verified else "size_mismatch",
            "verified": verified,
            "checksum": checksum,
            "filepath": filepath,
            "actual_size": actual_size,
            "error": verify_error,
        })

        if verified:
            dl["stats"]["completed"] += 1
        else:
            dl["stats"]["failed"] += 1

        socketio.emit("file_complete", {
            "id": fid,
            "filename": filename,
            "filepath": filepath,
            "size": actual_size,
            "size_fmt": format_bytes(actual_size),
            "expected_size": expected_size,
            "width": width,
            "height": height,
            "checksum": checksum,
            "verified": verified,
            "error": verify_error,
            "file_num": file_num,
            "total_files": total_files,
            "completed": dl["stats"]["completed"],
            "failed": dl["stats"]["failed"],
        })

        # ── Delete from iCloud if requested & verified ────────────────────────
        if delete_after and verified:
            try:
                photo.delete()
                dl["files"][fid]["deleted_from_icloud"] = True
                socketio.emit("file_deleted", {"id": fid, "filename": filename})
            except Exception as exc:
                dl["files"][fid]["delete_error"] = str(exc)
                socketio.emit("file_delete_error", {
                    "id": fid, "filename": filename, "error": str(exc)
                })

    except Exception as exc:
        dl["files"][fid].update({"status": "error", "error": str(exc)})
        dl["stats"]["failed"] += 1
        socketio.emit("file_error", {
            "id": fid, "filename": filename, "error": str(exc), "file_num": file_num
        })
        if os.path.exists(filepath):
            try:
                os.unlink(filepath)
            except Exception:
                pass


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("  iCloud Downloader")
    print("  http://localhost:5000")
    print("=" * 60)
    socketio.run(app, host="0.0.0.0", port=5000, debug=True, allow_unsafe_werkzeug=True)
