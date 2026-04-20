/**
 * iCloud Downloader – Frontend JavaScript
 */

"use strict";

// ── Socket.IO ────────────────────────────────────────────────────────────────
const socket = io({ transports: ["websocket", "polling"] });

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  currentAlbum: null,
  currentPhotos: [],         // photos loaded in browse tab
  currentPage: 1,
  selectedIds: new Set(),
  downloadQueue: [],         // {id, filename, size, size_fmt, media_type, album, all?}
  results: [],               // completed download results
  deletedCount: 0,
  isDownloading: false,
  showThumbs: false,
  viewMode: "list",          // "list" | "grid"
  gridSize: 150,
  albums: [],                // all albums from albums_done
  selectedAlbums: new Set(), // selected album names in albums tab
  fromAlbumsTab: false,      // navigated to browse from albums tab
  albumSort: "iphone",       // "iphone" | "alpha"
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadPrefs();
  document.getElementById("inp-outdir").addEventListener("change", savePrefs);
});

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════════

async function doLogin() {
  const email    = document.getElementById("inp-email").value.trim();
  const password = document.getElementById("inp-password").value;

  if (!email || !password) {
    showLoginError("Introduce email y contraseña");
    return;
  }

  setLoginBtnLoading(true);
  hideLoginError();

  try {
    const res  = await apiFetch("/api/login", { email, password });
    const data = await res.json();

    if (data.status === "2fa_required") {
      show2FA();
    } else if (data.status === "ok") {
      onLoginOk(data.username);
    } else {
      showLoginError(data.error || "Error de autenticación");
    }
  } catch (e) {
    showLoginError("Error de conexión: " + e.message);
  } finally {
    setLoginBtnLoading(false);
  }
}

async function do2FA() {
  const code = document.getElementById("inp-code").value.trim();
  if (code.length < 6) {
    showLoginError("El código debe tener 6 dígitos");
    return;
  }

  const btn = document.getElementById("btn-2fa");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Verificando...';
  hideLoginError();

  try {
    const res  = await apiFetch("/api/verify_2fa", { code });
    const data = await res.json();

    if (data.status === "ok") {
      onLoginOk(data.username);
    } else {
      showLoginError(data.error || "Código incorrecto");
    }
  } catch (e) {
    showLoginError("Error: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Verificar';
  }
}

function onLoginOk(username) {
  document.getElementById("login-screen").classList.add("d-none");
  document.getElementById("main-app").classList.remove("d-none");
  document.getElementById("nav-username").textContent = username;
  loadStorage();
  loadAlbums();
}

async function doLogout() {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
}

function show2FA() {
  document.getElementById("login-form").classList.add("d-none");
  document.getElementById("twofa-form").classList.remove("d-none");
  setTimeout(() => document.getElementById("inp-code").focus(), 50);
  hideLoginError();
}

function resetLogin() {
  document.getElementById("twofa-form").classList.add("d-none");
  document.getElementById("login-form").classList.remove("d-none");
  hideLoginError();
}

function setLoginBtnLoading(loading) {
  const btn = document.getElementById("btn-login");
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<span class="spinner-border spinner-border-sm me-2"></span>Conectando...'
    : '<i class="fas fa-sign-in-alt me-2"></i>Iniciar sesión';
}

function showLoginError(msg) {
  const el = document.getElementById("login-error");
  el.textContent = msg;
  el.classList.remove("d-none");
}
function hideLoginError() {
  document.getElementById("login-error").classList.add("d-none");
}

function togglePassVis(inputId, btn) {
  const inp = document.getElementById(inputId);
  const isPass = inp.type === "password";
  inp.type = isPass ? "text" : "password";
  btn.innerHTML = isPass ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
}

// ══════════════════════════════════════════════════════════════════════════════
//  STORAGE
// ══════════════════════════════════════════════════════════════════════════════

async function loadStorage() {
  try {
    const res  = await fetch("/api/storage");
    const data = await res.json();

    if (data.error) return;

    const pct = data.percent || 0;
    document.getElementById("stor-bar").style.width = pct + "%";

    const bar = document.getElementById("stor-bar");
    bar.className = "progress-bar " + (pct > 90 ? "bg-danger" : pct > 75 ? "bg-warning" : "bg-info");

    document.getElementById("stor-label").textContent =
      `${data.used_fmt} / ${data.total_fmt} (${pct}%)`;

    document.getElementById("stor-detail").textContent =
      `${data.available_fmt} disponibles`;
  } catch (e) {
    document.getElementById("stor-label").textContent = "No disponible";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ALBUMS
// ══════════════════════════════════════════════════════════════════════════════

function _albumsProgressHTML(pct, loaded, total, eta) {
  const etaTxt = eta > 0
    ? (eta < 60 ? `${eta}s` : `${Math.floor(eta/60)}m ${eta%60}s`)
    : "—";
  return `
    <div class="px-3 pt-3 pb-2">
      <div class="d-flex justify-content-between mb-1" style="font-size:0.75rem;">
        <span class="text-muted">Cargando álbumes… ${loaded}/${total}</span>
        <span style="color:#0a84ff; font-weight:600;">${pct}% · ETA ${etaTxt}</span>
      </div>
      <div style="height:8px; background:#21262d; border-radius:4px; overflow:hidden;">
        <div style="height:8px; width:${Math.max(pct,3)}%; background:#0a84ff;
             transition:width 0.3s;
             background-image:linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent);
             background-size:1rem 1rem; animation:progress-bar-stripes 1s linear infinite;"></div>
      </div>
    </div>`;
}

async function loadAlbums() {
  const list = document.getElementById("album-list");
  list.innerHTML = _albumsProgressHTML(0, 0, '?', 0);

  try {
    const res = await fetch("/api/albums/stream", { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (e) {
    list.innerHTML = `<div class="text-danger small p-3">
      <i class="fas fa-exclamation-triangle me-1"></i>${escHtml(e.message)}
    </div>`;
  }
}

socket.on("albums_start", d => {
  const list = document.getElementById("album-list");
  list.innerHTML = _albumsProgressHTML(0, 0, d.total, 0);
});

socket.on("albums_progress", d => {
  const list = document.getElementById("album-list");
  list.innerHTML = _albumsProgressHTML(d.pct, d.loaded, d.total, d.eta);
});

socket.on("albums_done", d => {
  state.albums = d.albums;
  state.selectedAlbums = new Set();
  _rebuildSidebar();
  renderAlbumsTab();
  document.getElementById("albums-tab-status").textContent =
    `${fmtNum(d.albums.length)} álbumes`;
});

socket.on("albums_error", d => {
  document.getElementById("album-list").innerHTML =
    `<div class="text-danger small p-3"><i class="fas fa-exclamation-triangle me-1"></i>${escHtml(d.error)}</div>`;
});

function buildAlbumItem(album) {
  const div = document.createElement("div");
  div.className = "album-item" + (album.shared ? " album-item-shared" : "");
  div.dataset.name = album.name;
  const displayName = album.display_name || album.name;
  const icon = album.shared ? "share-alt" : albumIcon(displayName);
  div.innerHTML = `
    <i class="fas fa-${icon} album-icon${album.shared ? " text-info" : ""}"></i>
    <span class="album-name">${escHtml(displayName)}</span>
    <span class="album-count">${fmtNum(album.count)}</span>
  `;
  div.onclick = () => selectAlbum(album.name, displayName, div);
  return div;
}

function albumIcon(name) {
  const map = {
    "All Photos":        "images",
    "Favorites":         "heart",
    "Recently Deleted":  "trash",
    "Videos":            "video",
    "Selfies":           "user",
    "Portrait":          "user-circle",
    "Live Photos":       "circle-play",
    "Panoramas":         "panorama",
    "Bursts":            "images",
    "Screenshots":       "desktop",
    "Screen Recordings": "record-vinyl",
    "Animados":          "film",
  };
  return map[name] || "folder";
}

async function selectAlbum(name, displayName, el) {
  document.querySelectorAll(".album-item").forEach(a => a.classList.remove("active"));
  if (el) el.classList.add("active");

  state.currentAlbum = name;
  state.currentPhotos = [];
  state.selectedIds.clear();
  state.currentPage = 1;

  document.getElementById("album-title").textContent = displayName || name;
  document.getElementById("album-badge").textContent = "";
  document.getElementById("album-size-badge").textContent = "";
  document.getElementById("photos-tbody").innerHTML = "";
  document.getElementById("loading-more-footer").classList.add("d-none");
  hideAlbumProgress();

  setPhotoState("loading");
  showAlbumProgress(0, 0, "Conectando con iCloud...");
  showTab("browse");
  updateSelectionUI();

  await fetch("/api/album/cancel_load", { method: "POST" });

  try {
    const res  = await fetch(`/api/album/${encodeURIComponent(name)}/stream`, { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const total = data.total || 0;
    showAlbumProgress(0, total, total > 0 ? `0 / ${fmtNum(total)} fotos` : "Cargando fotos...");
  } catch (e) {
    hideAlbumProgress();
    setPhotoState("error", e.message);
  }
}

function loadMorePhotos() { /* replaced by socket streaming */ }

function _thumbTag(id) {
  const url = `/api/photo/${encodeURIComponent(id)}/preview`;
  return state.showThumbs
    ? `<img class="photo-thumb" src="${url}" alt="">`
    : `<img class="photo-thumb" data-src="${url}" alt="">`;
}

function renderPhotoTable() {
  const tbody = document.getElementById("photos-tbody");
  tbody.innerHTML = "";

  const table = document.querySelector("#photos-wrapper table");
  if (table) table.classList.toggle("thumbs-on", state.showThumbs);

  for (let i = 0; i < state.currentPhotos.length; i++) {
    const photo = state.currentPhotos[i];
    const tr = document.createElement("tr");
    tr.className = "photo-row";
    tr.dataset.id = photo.id;

    const checked = state.selectedIds.has(photo.id);
    tr.innerHTML = `
      <td><input type="checkbox" class="form-check-input photo-chk"
                 data-id="${escAttr(photo.id)}" ${checked ? "checked" : ""}
                 onchange="onPhotoCheck('${escAttr(photo.id)}', this)"></td>
      <td class="text-light">
        ${_thumbTag(photo.id)}
        <i class="fas fa-${fileIcon(photo.media_type)} me-2 text-secondary"></i>
        <span class="text-truncate">${escHtml(photo.filename)}</span>
      </td>
      <td class="text-muted">${photo.date ? fmtDate(photo.date) : "—"}</td>
      <td class="text-muted">${photo.size_fmt || (photo.size ? fmtBytes(photo.size) : "—")}</td>
      <td><span class="badge bg-dark text-muted border border-secondary"
               style="font-size:0.68rem">${mediaLabel(photo.media_type)}</span></td>
    `;

    const photoIndex = i;
    tr.onclick = e => {
      if (e.target.type === "checkbox") return;
      openPreview(photoIndex);
    };

    tbody.appendChild(tr);
  }
}

function setPhotoState(state_name, errorMsg) {
  if (state_name === "loading") {
    document.getElementById("photos-tbody").innerHTML = "";
    document.getElementById("photo-grid").innerHTML = "";
    // Reset placeholder to default in case it was showing a "deleted" message
    document.getElementById("photos-placeholder-icon").className = "fas fa-folder-open fa-3x mb-3 text-muted d-block";
    document.getElementById("photos-placeholder-text").textContent = "Selecciona un álbum en la barra lateral";
  }
  const isTable = state_name === "table";
  document.getElementById("photos-placeholder").classList.toggle("d-none", state_name !== "idle");
  document.getElementById("photos-loading").classList.toggle("d-none",   state_name !== "loading");
  document.getElementById("photos-wrapper").classList.toggle("d-none",   !isTable);

  if (isTable) {
    document.getElementById("photos-table").classList.toggle("d-none", state.viewMode === "grid");
    document.getElementById("photo-grid").classList.toggle("d-none",   state.viewMode !== "grid");
  }

  if (state_name === "error") {
    document.getElementById("photos-placeholder").classList.remove("d-none");
    document.getElementById("photos-placeholder-icon").className = "fas fa-exclamation-triangle fa-3x mb-3 d-block text-danger";
    document.getElementById("photos-placeholder-text").innerHTML = `<div class="text-danger">${escHtml(errorMsg)}</div>`;
  }
}

function fileIcon(mt) {
  if (!mt) return "file";
  if (mt.startsWith("video/")) return "video";
  if (mt.includes("heic") || mt.includes("heif")) return "file-image";
  if (mt.startsWith("image/")) return "image";
  return "file";
}

function mediaLabel(mt) {
  if (!mt) return "?";
  return mt.split("/").pop().toUpperCase().slice(0, 8);
}

// ══════════════════════════════════════════════════════════════════════════════
//  ALBUM PROGRESS BAR
// ══════════════════════════════════════════════════════════════════════════════

function showAlbumProgress(loaded, total, label) {
  const pct  = total > 0 ? Math.round(loaded / total * 100) : 0;
  const barW = total > 0 ? Math.max(pct, 5) + "%" : "100%";

  document.getElementById("gbar-wrap").style.display  = "block";
  document.getElementById("gbar-fill").style.width    = barW;
  document.getElementById("gbar-label").style.display = "block";
  document.getElementById("gbar-text").textContent    = label;
  document.getElementById("gbar-pct").textContent     = total > 0 ? pct + "%" : "";

  // También actualiza el div photos-loading mientras esté visible
  const bar = document.getElementById("album-load-bar");
  if (bar) { bar.style.width = barW; bar.textContent = total > 0 ? pct + "%" : ""; }
  const cnt = document.getElementById("album-load-count");
  if (cnt) cnt.textContent = label;
  const sts = document.getElementById("album-load-status");
  if (sts) sts.textContent = total > 0 ? `Cargando ${fmtNum(total)} elementos...` : "Cargando fotos...";
}

function hideAlbumProgress() {
  document.getElementById("gbar-wrap").style.display  = "none";
  document.getElementById("gbar-label").style.display = "none";
}

// ══════════════════════════════════════════════════════════════════════════════
//  ALBUM STREAMING (Socket.IO)
// ══════════════════════════════════════════════════════════════════════════════

socket.on("album_photos_batch", d => {
  if (d.album !== state.currentAlbum) return;

  const wasEmpty = state.currentPhotos.length === 0;
  const startIdx = state.currentPhotos.length;
  state.currentPhotos.push(...d.photos);

  if (state.viewMode === "grid") {
    appendPhotoCards(d.photos, startIdx);
  } else {
    appendPhotoRows(d.photos, startIdx);
  }

  if (wasEmpty) {
    setPhotoState("table");
    document.getElementById("loading-more-footer").classList.remove("d-none");
  }

  const pct   = d.total > 0 ? Math.round(d.loaded / d.total * 100) : 0;
  const label = d.total > 0
    ? `${fmtNum(d.loaded)} / ${fmtNum(d.total)} fotos`
    : `${fmtNum(d.loaded)} fotos`;
  showAlbumProgress(d.loaded, d.total, label);

  document.getElementById("album-badge").textContent =
    `${fmtNum(d.loaded)}${d.loaded < (d.total || d.loaded + 1) ? "+" : ""} fotos`;

  const totalSize = state.currentPhotos.reduce((s, p) => s + (p.size || 0), 0);
  document.getElementById("album-size-badge").textContent = totalSize > 0 ? fmtBytes(totalSize) : "";
});

socket.on("album_loading_done", d => {
  if (d.album !== state.currentAlbum) return;
  hideAlbumProgress();
  document.getElementById("loading-more-footer").classList.add("d-none");
  document.getElementById("album-badge").textContent = `${fmtNum(d.total)} fotos`;
  if (state.currentPhotos.length === 0) setPhotoState("idle");
});

socket.on("album_loading_error", d => {
  if (d.album !== state.currentAlbum) return;
  hideAlbumProgress();
  document.getElementById("loading-more-footer").classList.add("d-none");
  setPhotoState("error", d.error);
});

function appendPhotoRows(photos, startIndex) {
  const tbody = document.getElementById("photos-tbody");
  for (let j = 0; j < photos.length; j++) {
    const photo = photos[j];
    const i     = startIndex + j;
    const tr    = document.createElement("tr");
    tr.className  = "photo-row";
    tr.dataset.id = photo.id;
    const checked = state.selectedIds.has(photo.id);
    tr.innerHTML = `
      <td><input type="checkbox" class="form-check-input photo-chk"
                 data-id="${escAttr(photo.id)}" ${checked ? "checked" : ""}
                 onchange="onPhotoCheck('${escAttr(photo.id)}', this)"></td>
      <td class="text-light">
        ${_thumbTag(photo.id)}
        <i class="fas fa-${fileIcon(photo.media_type)} me-2 text-secondary"></i>
        <span class="text-truncate">${escHtml(photo.filename)}</span>
      </td>
      <td class="text-muted">${photo.date ? fmtDate(photo.date) : "—"}</td>
      <td class="text-muted">${photo.size_fmt || (photo.size ? fmtBytes(photo.size) : "—")}</td>
      <td><span class="badge bg-dark text-muted border border-secondary"
               style="font-size:0.68rem">${mediaLabel(photo.media_type)}</span></td>
    `;
    const photoIndex = i;
    tr.onclick = e => {
      if (e.target.type === "checkbox") return;
      openPreview(photoIndex);
    };
    tbody.appendChild(tr);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  PHOTO SELECTION
// ══════════════════════════════════════════════════════════════════════════════

function onPhotoCheck(id, chk) {
  if (chk.checked) state.selectedIds.add(id);
  else             state.selectedIds.delete(id);
  updateSelectionUI();
}

function toggleSelectAll(masterChk) {
  document.querySelectorAll(".photo-chk").forEach(c => {
    c.checked = masterChk.checked;
    if (masterChk.checked) state.selectedIds.add(c.dataset.id);
    else                   state.selectedIds.delete(c.dataset.id);
  });
  updateSelectionUI();
}

function selectAll() {
  document.getElementById("chk-all").checked = true;
  document.querySelectorAll(".photo-chk").forEach(c => {
    c.checked = true;
    state.selectedIds.add(c.dataset.id);
  });
  updateSelectionUI();
}

function selectNone() {
  document.getElementById("chk-all").checked = false;
  document.querySelectorAll(".photo-chk").forEach(c => {
    c.checked = false;
  });
  state.selectedIds.clear();
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = state.selectedIds.size;
  const footer = document.getElementById("sel-footer");

  if (n > 0) {
    footer.classList.remove("d-none");
    document.getElementById("sel-count").textContent =
      `${fmtNum(n)} elemento${n !== 1 ? "s" : ""} seleccionado${n !== 1 ? "s" : ""}`;

    const selPhotos = state.currentPhotos.filter(p => state.selectedIds.has(p.id));
    const totalSz = selPhotos.reduce((s, p) => s + (p.size || 0), 0);
    document.getElementById("sel-size").textContent = totalSz > 0 ? `· ${fmtBytes(totalSz)}` : "";
  } else {
    footer.classList.add("d-none");
  }
}

function addSelectionToQueue() {
  if (state.selectedIds.size === 0) return;

  const selPhotos = state.currentPhotos.filter(p => state.selectedIds.has(p.id));
  const existIds  = new Set(state.downloadQueue.map(q => q.id));
  const newItems  = selPhotos.filter(p => !existIds.has(p.id));

  state.downloadQueue.push(...newItems);
  renderQueue();
  showTab("download");
  selectNone();
  toast(`${fmtNum(newItems.length)} elemento${newItems.length !== 1 ? "s" : ""} añadidos a la cola`, "success");
}

function queueAll() {
  state.downloadQueue = [{ id: "__all__", filename: "Todas las fotos y vídeos de iCloud", all: true }];
  renderQueue();
  showTab("download");
}

// ══════════════════════════════════════════════════════════════════════════════
//  ALBUMS TAB
// ══════════════════════════════════════════════════════════════════════════════

function _sortedAlbums() {
  const alpha = state.albumSort === "alpha";
  return [...state.albums].sort((a, b) => {
    // Library always first
    const aLib = a.name === "Library" || a.name === "All Photos";
    const bLib = b.name === "Library" || b.name === "All Photos";
    if (aLib !== bLib) return aLib ? -1 : 1;
    // Shared always last
    if (a.shared !== b.shared) return a.shared ? 1 : -1;
    // Within group: alpha or original iPhone position
    if (alpha) {
      return (a.display_name || a.name).localeCompare(b.display_name || b.name, undefined, { sensitivity: "base" });
    }
    return (a.position ?? 999) - (b.position ?? 999);
  });
}

function setAlbumSort(mode) {
  state.albumSort = mode;
  document.getElementById("btn-sort-iphone").classList.toggle("active", mode === "iphone");
  document.getElementById("btn-sort-alpha").classList.toggle("active",  mode === "alpha");
  renderAlbumsTab();
  _rebuildSidebar();
  savePrefs();
}

function _rebuildSidebar() {
  const list = document.getElementById("album-list");
  if (!list) return;
  list.innerHTML = "";

  const sorted  = _sortedAlbums();
  const normals = sorted.filter(a => !a.shared);
  const shareds = sorted.filter(a => a.shared);

  // Personal albums section
  const hdrNormal = document.createElement("div");
  hdrNormal.className = "album-section-header";
  hdrNormal.innerHTML = `<i class="fas fa-folder me-1 text-warning"></i>Mis álbumes`;
  list.appendChild(hdrNormal);
  normals.forEach(a => list.appendChild(buildAlbumItem(a)));

  // Shared albums section
  if (shareds.length > 0) {
    const hdrShared = document.createElement("div");
    hdrShared.className = "album-section-header";
    hdrShared.innerHTML = `<i class="fas fa-share-alt me-1 text-info"></i>Compartidos`;
    list.appendChild(hdrShared);
    shareds.forEach(a => list.appendChild(buildAlbumItem(a)));
  }
}

function renderAlbumsTab() {
  const normalEl = document.getElementById("album-cards-normal");
  const sharedEl = document.getElementById("album-cards-shared");
  if (!normalEl || !sharedEl) return;
  normalEl.innerHTML = "";
  sharedEl.innerHTML = "";

  const sorted   = _sortedAlbums();
  const normals  = sorted.filter(a => !a.shared);
  const shareds  = sorted.filter(a => a.shared);

  if (normals.length === 0)
    normalEl.innerHTML = `<div class="text-muted small py-2">Sin álbumes personales</div>`;
  else
    normals.forEach(a => normalEl.appendChild(buildAlbumCard(a)));

  if (shareds.length === 0)
    sharedEl.innerHTML = `<div class="text-muted small py-2">Sin álbumes compartidos</div>`;
  else
    shareds.forEach(a => sharedEl.appendChild(buildAlbumCard(a)));
}

function buildAlbumCard(album) {
  const name  = album.name;
  const label = album.display_name || name;
  const sel   = state.selectedAlbums.has(name);

  const card = document.createElement("div");
  card.className  = "album-exp-card" + (sel ? " selected" : "");
  card.dataset.name = name;

  card.innerHTML = `
    <div class="album-exp-thumb">
      <i class="fas fa-${album.shared ? "share-alt" : albumIcon(label)} fa-2x"></i>
    </div>
    <div class="album-exp-label">
      <div class="album-exp-name">${escHtml(label)}</div>
      <div class="album-exp-count">${fmtNum(album.count)} fotos</div>
    </div>
    <button class="album-exp-sel${sel ? " sel" : ""}" title="Seleccionar">
      <i class="fas ${sel ? "fa-check-circle" : "fa-circle"}"></i>
    </button>`;

  // Select button
  card.querySelector(".album-exp-sel").onclick = e => {
    e.stopPropagation();
    const nowSel = !state.selectedAlbums.has(name);
    if (nowSel) state.selectedAlbums.add(name); else state.selectedAlbums.delete(name);
    card.classList.toggle("selected", nowSel);
    const btn = card.querySelector(".album-exp-sel");
    btn.classList.toggle("sel", nowSel);
    btn.querySelector("i").className = `fas ${nowSel ? "fa-check-circle" : "fa-circle"}`;
    updateAlbumSelUI();
  };

  // Card click → go to explore tab and load album
  card.onclick = () => {
    state.fromAlbumsTab = true;
    document.getElementById("btn-back-albums").classList.remove("d-none");
    showTab("browse");
    const sideItem = document.querySelector(`.album-item[data-name="${CSS.escape(name)}"]`);
    selectAlbum(name, label, sideItem);
  };

  return card;
}

function backToAlbums() {
  state.fromAlbumsTab = false;
  document.getElementById("btn-back-albums").classList.add("d-none");
  showTab("albums");
}

function _removeAlbumFromUI(name) {
  // 1. Remove from state
  state.albums = state.albums.filter(a => a.name !== name);

  // 2. Remove card in albums tab
  document.querySelector(`.album-exp-card[data-name="${CSS.escape(name)}"]`)?.remove();

  // 3. Remove item in sidebar
  document.querySelector(`.album-item[data-name="${CSS.escape(name)}"]`)?.remove();

  // 4. Update albums-tab-status counter
  document.getElementById("albums-tab-status").textContent =
    `${fmtNum(state.albums.length)} álbumes`;

  // 5. If currently viewing this album in browse, clear the view
  if (state.currentAlbum === name) {
    state.currentAlbum = null;
    document.getElementById("album-title").textContent = "Álbum eliminado";
    document.getElementById("album-badge").textContent = "";
    document.getElementById("album-size-badge").textContent = "";
    document.getElementById("photos-wrapper").classList.add("d-none");
    document.getElementById("photo-grid").classList.add("d-none");
    document.getElementById("photos-placeholder-icon").className = "fas fa-trash-alt fa-3x mb-3 text-danger d-block";
    document.getElementById("photos-placeholder-text").textContent = "El álbum ha sido eliminado de iCloud";
    document.getElementById("photos-placeholder").classList.remove("d-none");
    document.getElementById("photos-loading").classList.add("d-none");
  }
}

function updateAlbumSelUI() {
  const n = state.selectedAlbums.size;
  const footer = document.getElementById("album-sel-footer");
  footer.classList.toggle("d-none", n === 0);
  if (n === 0) return;

  const selAlbums = state.albums.filter(a => state.selectedAlbums.has(a.name));
  const total     = selAlbums.reduce((s, a) => s + (a.count || 0), 0);
  document.getElementById("album-sel-count").textContent =
    `${fmtNum(n)} álbum${n !== 1 ? "es" : ""} seleccionado${n !== 1 ? "s" : ""}`;
  document.getElementById("album-sel-total").textContent =
    total > 0 ? `· ~${fmtNum(total)} fotos` : "";
}

function addAlbumsToQueue() {
  if (state.selectedAlbums.size === 0) return;
  const existNames = new Set(state.downloadQueue.filter(q => q.type === "album").map(q => q.name));
  let added = 0;
  for (const name of state.selectedAlbums) {
    if (existNames.has(name)) continue;
    const album = state.albums.find(a => a.name === name);
    if (!album) continue;
    state.downloadQueue.push({
      type: "album",
      id: "alb:" + name,
      name,
      displayName: album.display_name || name,
      count: album.count,
      shared: album.shared,
    });
    added++;
  }
  state.selectedAlbums.clear();
  document.querySelectorAll(".album-exp-card.selected").forEach(c => {
    c.classList.remove("selected");
    const btn = c.querySelector(".album-exp-sel");
    if (btn) { btn.classList.remove("sel"); btn.querySelector("i").className = "fas fa-circle"; }
  });
  updateAlbumSelUI();
  renderQueue();
  showTab("download");
  toast(`${fmtNum(added)} álbum${added !== 1 ? "es" : ""} añadido${added !== 1 ? "s" : ""} a la cola`, "success");
}

async function deleteSelectedAlbums() {
  if (state.selectedAlbums.size === 0) return;
  const names = [...state.selectedAlbums];

  // Separate shared vs normal albums
  const sharedNames = names.filter(n => state.albums.find(a => a.name === n)?.shared);
  const normalNames = names.filter(n => !state.albums.find(a => a.name === n)?.shared);

  // Build confirm message
  let msg = "";
  if (normalNames.length > 0) {
    const normalLabels = normalNames.map(n => { const a = state.albums.find(a => a.name === n); return a?.display_name || n; });
    msg += `¿Eliminar TODAS las fotos de ${normalNames.length} álbum${normalNames.length !== 1 ? "es" : ""} de iCloud?\n\n${normalLabels.join(", ")}`;
  }
  if (sharedNames.length > 0) {
    const sharedLabels = sharedNames.map(n => { const a = state.albums.find(a => a.name === n); return a?.display_name || n; });
    if (msg) msg += "\n\n";
    msg += `¿Abandonar ${sharedNames.length} álbum${sharedNames.length !== 1 ? "es" : ""} compartido${sharedNames.length !== 1 ? "s" : ""}?\n\n${sharedLabels.join(", ")}`;
  }
  msg += "\n\nEsta acción no se puede deshacer.";
  if (!confirm(msg)) return;

  let totalDeleted = 0, totalErrors = 0, albumsRemoved = 0;

  // Process normal albums — delete photos + album container
  for (const name of normalNames) {
    try {
      const res  = await apiFetch(`/api/album/${encodeURIComponent(name)}/delete_photos`, {});
      const data = await res.json();
      if (data.error) { toast(`Error en "${name}": ${data.error}`, "danger"); totalErrors++; continue; }
      totalDeleted += data.deleted || 0;
      totalErrors  += (data.errors || []).length;
      if (data.album_deleted) {
        _removeAlbumFromUI(name);
        albumsRemoved++;
      } else if (data.album_delete_error) {
        toast(`"${name}": ${data.album_delete_error}`, "warning");
      }
    } catch (e) {
      toast(`Error en "${name}": ${e.message}`, "danger");
      totalErrors++;
    }
  }

  // Process shared albums — leave / unsubscribe
  for (const name of sharedNames) {
    const album = state.albums.find(a => a.name === name);
    const label = album?.display_name || name;
    try {
      const res  = await apiFetch(`/api/album/${encodeURIComponent(name)}/leave`, {});
      const data = await res.json();
      if (data.error) { toast(`Error al abandonar "${label}": ${data.error}`, "danger"); totalErrors++; continue; }
      if (data.left) {
        _removeAlbumFromUI(name);
        albumsRemoved++;
      } else {
        toast(`No se pudo abandonar "${label}"`, "warning");
        totalErrors++;
      }
    } catch (e) {
      toast(`Error al abandonar "${label}": ${e.message}`, "danger");
      totalErrors++;
    }
  }

  state.selectedAlbums.clear();
  updateAlbumSelUI();
  const parts = [];
  if (totalDeleted > 0)  parts.push(`${fmtNum(totalDeleted)} fotos eliminadas`);
  if (albumsRemoved > 0) parts.push(`${fmtNum(albumsRemoved)} álbum${albumsRemoved !== 1 ? "es" : ""} eliminado${albumsRemoved !== 1 ? "s" : ""}`);
  toast(
    parts.length ? parts.join(" · ") + (totalErrors > 0 ? ` (${totalErrors} errores)` : "") : "Sin cambios",
    totalErrors > 0 ? "warning" : "success"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD QUEUE
// ══════════════════════════════════════════════════════════════════════════════

function renderQueue() {
  const container = document.getElementById("queue-items");
  const badge     = document.getElementById("badge-queue");
  const countLbl  = document.getElementById("lbl-queue-count");
  const n         = state.downloadQueue.length;

  badge.textContent = n;
  badge.classList.toggle("d-none", n === 0);
  countLbl.textContent = `${fmtNum(n)} elemento${n !== 1 ? "s" : ""}`;
  container.innerHTML = "";

  if (n === 0) {
    container.innerHTML = `<div class="text-muted small py-3 text-center">
      <i class="fas fa-inbox me-2"></i>La cola está vacía. Selecciona fotos o álbumes.
    </div>`;
    return;
  }

  const allEntry = state.downloadQueue.find(q => q.all);
  if (allEntry) {
    const div = document.createElement("div");
    div.className = "queue-group";
    div.innerHTML = `
      <div class="queue-group-header">
        <i class="fas fa-cloud-download-alt text-primary me-2"></i>
        <span class="text-light fw-semibold">Toda la biblioteca iCloud</span>
        <button class="btn btn-xs btn-outline-danger ms-auto" onclick="clearQueue()">
          <i class="fas fa-times"></i>
        </button>
      </div>`;
    container.appendChild(div);
    return;
  }

  // Group by album
  const groups = new Map(); // key -> {label, icon, items: [], isAlbum}
  for (let i = 0; i < n; i++) {
    const q = state.downloadQueue[i];
    if (q.type === "album") {
      const key = "__alb__:" + q.name;
      groups.set(key, { label: q.displayName || q.name, icon: q.shared ? "share-alt" : "folder", isAlbum: true, albumIdx: i, count: q.count, items: [] });
    } else {
      const key = q.album || "__none__";
      if (!groups.has(key)) groups.set(key, { label: key === "__none__" ? "Sin álbum" : key, icon: "folder", isAlbum: false, items: [] });
      groups.get(key).items.push({ q, i });
    }
  }

  let totalSz = 0;
  for (const [, grp] of groups) {
    const section = document.createElement("div");
    section.className = "queue-group";

    if (grp.isAlbum) {
      section.innerHTML = `
        <div class="queue-group-header">
          <i class="fas fa-${grp.icon} text-warning me-2"></i>
          <span class="text-light fw-semibold">${escHtml(grp.label)}</span>
          ${grp.count ? `<span class="text-muted small ms-1">(${fmtNum(grp.count)} fotos)</span>` : ""}
          <button class="btn btn-xs btn-outline-danger ms-auto" onclick="removeFromQueue(${grp.albumIdx})">
            <i class="fas fa-times"></i>
          </button>
        </div>`;
    } else {
      const groupSz = grp.items.reduce((s, x) => s + (x.q.size || 0), 0);
      totalSz += groupSz;
      const MAX = 4;
      const rows = grp.items.slice(0, MAX).map(({ q, i }) => `
        <div class="queue-item">
          <i class="fas fa-${fileIcon(q.media_type)} text-secondary"></i>
          <span class="qi-name text-light">${escHtml(q.filename)}</span>
          ${q.size ? `<span class="text-muted small flex-shrink-0">${fmtBytes(q.size)}</span>` : ""}
          <button class="btn btn-xs btn-outline-danger flex-shrink-0" onclick="removeFromQueue(${i})">
            <i class="fas fa-times"></i>
          </button>
        </div>`).join("");
      const more = grp.items.length > MAX
        ? `<div class="text-muted small ps-3 py-1">… y ${fmtNum(grp.items.length - MAX)} más</div>` : "";
      section.innerHTML = `
        <div class="queue-group-header">
          <i class="fas fa-folder text-warning me-2"></i>
          <span class="text-light fw-semibold">${escHtml(grp.label)}</span>
          <span class="text-muted small ms-1">(${fmtNum(grp.items.length)} fotos${groupSz ? " · " + fmtBytes(groupSz) : ""})</span>
        </div>
        ${rows}${more}`;
    }
    container.appendChild(section);
  }

  if (totalSz > 0) {
    const sz = document.createElement("div");
    sz.className = "text-muted small text-end pt-1 px-1";
    sz.innerHTML = `<i class="fas fa-hdd me-1"></i>Total estimado: <strong>${fmtBytes(totalSz)}</strong>`;
    container.appendChild(sz);
  }
}

function removeFromQueue(idx) {
  state.downloadQueue.splice(idx, 1);
  renderQueue();
}

function clearQueue() {
  if (state.isDownloading) return;
  state.downloadQueue = [];
  renderQueue();
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD CONFIG
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
//  PREFERENCIAS (cookies)
// ══════════════════════════════════════════════════════════════════════════════

function setCookie(name, value, days = 365) {
  const exp = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${exp};path=/`;
}

function getCookie(name) {
  for (const part of document.cookie.split(";")) {
    const c = part.trim();
    if (c.startsWith(name + "=")) return decodeURIComponent(c.slice(name.length + 1));
  }
  return null;
}

function savePrefs() {
  const prefs = {
    outdir:      document.getElementById("inp-outdir")?.value || "",
    deleteAfter: document.getElementById("chk-delete")?.checked || false,
    viewMode:    state.viewMode,
    gridSize:    state.gridSize,
    showThumbs:  state.showThumbs,
    albumSort:   state.albumSort,
  };
  setCookie("icloud_prefs", JSON.stringify(prefs));
}

function loadPrefs() {
  const raw = getCookie("icloud_prefs");
  const outdirEl = document.getElementById("inp-outdir");

  if (!raw) {
    setDefaultDir();
    return;
  }

  try {
    const p = JSON.parse(raw);

    // Directorio de descarga
    if (outdirEl) outdirEl.value = p.outdir || "";
    if (!p.outdir && outdirEl) setDefaultDir();

    // Borrar tras descarga
    if (p.deleteAfter) {
      const chk = document.getElementById("chk-delete");
      const box = document.getElementById("delete-toggle-box");
      if (chk) chk.checked = true;
      if (box) box.classList.add("active");
    }

    // Tamaño de cuadrícula (cargar antes de activar el modo)
    if (p.gridSize) {
      state.gridSize = p.gridSize;
      const slider = document.getElementById("grid-size-slider");
      if (slider) slider.value = p.gridSize;
    }

    // Modo de vista
    if (p.viewMode === "grid") setViewMode("grid");

    // Miniaturas en lista
    if (p.showThumbs) toggleThumbs();

    // Orden de álbumes
    if (p.albumSort === "alpha") {
      state.albumSort = "alpha";
      document.getElementById("btn-sort-iphone")?.classList.remove("active");
      document.getElementById("btn-sort-alpha")?.classList.add("active");
    }

  } catch {
    setDefaultDir();
  }
}

function setDefaultDir() {
  const now  = new Date();
  const pad  = n => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  document.getElementById("inp-outdir").value = `d:\\fotos\\${date}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  VIEW MODE (list / grid)
// ══════════════════════════════════════════════════════════════════════════════

function setViewMode(mode) {
  state.viewMode = mode;
  document.getElementById("btn-view-list").classList.toggle("active", mode === "list");
  document.getElementById("btn-view-grid").classList.toggle("active", mode === "grid");
  document.getElementById("grid-size-slider").style.display = mode === "grid" ? "inline-block" : "none";
  document.getElementById("btn-thumbs").style.display       = mode === "list"  ? ""            : "none";

  if (state.currentPhotos.length === 0) return;

  if (mode === "grid") {
    document.getElementById("photos-table").classList.add("d-none");
    const grid = document.getElementById("photo-grid");
    grid.classList.remove("d-none");
    grid.style.setProperty("--card-size", state.gridSize + "px");
    grid.innerHTML = "";
    appendPhotoCards(state.currentPhotos, 0);
  } else {
    document.getElementById("photo-grid").classList.add("d-none");
    const table = document.getElementById("photos-table");
    table.classList.remove("d-none");
    document.getElementById("photos-tbody").innerHTML = "";
    // Re-render en bloques para no bloquear UI
    let i = 0;
    const step = () => {
      if (i >= state.currentPhotos.length) return;
      appendPhotoRows(state.currentPhotos.slice(i, i + 200), i);
      i += 200;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function setGridSize(val) {
  state.gridSize = parseInt(val);
  document.getElementById("photo-grid").style.setProperty("--card-size", state.gridSize + "px");
  savePrefs();
}

function appendPhotoCards(photos, startIndex) {
  const grid = document.getElementById("photo-grid");
  const frag = document.createDocumentFragment();
  for (let j = 0; j < photos.length; j++) {
    const photo = photos[j];
    const i     = startIndex + j;
    const url   = `/api/photo/${encodeURIComponent(photo.id)}/preview`;
    const isVid = photo.media_type && photo.media_type.startsWith("video/");
    const sel   = state.selectedIds.has(photo.id);

    const card = document.createElement("div");
    card.className   = "photo-card" + (sel ? " selected" : "");
    card.dataset.id  = photo.id;
    card.dataset.idx = i;

    const meta = [photo.date ? fmtDate(photo.date) : "", photo.size_fmt || ""].filter(Boolean).join(" · ");

    card.innerHTML = `
      <div class="card-thumb-wrap">
        <img src="${url}" loading="lazy" alt="">
        ${isVid ? `<div class="card-play-icon"><i class="fas fa-play-circle"></i></div>` : ""}
        <button class="card-select-btn${sel ? " sel" : ""}" title="Seleccionar">
          <i class="fas ${sel ? "fa-check-circle" : "fa-circle"}"></i>
        </button>
      </div>
      <div class="card-label">
        <div class="card-filename">${escHtml(photo.filename)}</div>
        <div class="card-meta">${escHtml(meta)}</div>
      </div>`;

    // Botón seleccionar (círculo esquina) — no abre preview
    card.querySelector(".card-select-btn").onclick = e => {
      e.stopPropagation();
      const nowSel = !state.selectedIds.has(photo.id);
      if (nowSel) state.selectedIds.add(photo.id); else state.selectedIds.delete(photo.id);
      card.classList.toggle("selected", nowSel);
      const btn = card.querySelector(".card-select-btn");
      btn.classList.toggle("sel", nowSel);
      btn.querySelector("i").className = `fas ${nowSel ? "fa-check-circle" : "fa-circle"}`;
      updateSelectionUI();
    };

    // Clic en la tarjeta = abrir preview
    card.onclick = () => openPreview(i);

    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

// ══════════════════════════════════════════════════════════════════════════════
//  DELETE FROM PREVIEW
// ══════════════════════════════════════════════════════════════════════════════

async function deleteFromPreview() {
  const photo = state.currentPhotos[_previewIndex];
  if (!photo) return;
  try {
    const res = await fetch(`/api/photo/${encodeURIComponent(photo.id)}/delete`, { method: "POST" });
    const d   = await res.json();
    if (d.error) throw new Error(d.error);

    // Quitar de estado
    state.currentPhotos.splice(_previewIndex, 1);
    state.selectedIds.delete(photo.id);

    // Quitar fila/tarjeta del DOM
    const el = document.querySelector(`[data-id="${CSS.escape(photo.id)}"]`);
    if (el) el.remove();

    // Actualizar índices de las tarjetas restantes en grid
    if (state.viewMode === "grid") {
      document.querySelectorAll(".photo-card").forEach((c, idx) => { c.dataset.idx = idx; });
    }

    toast(`"${photo.filename}" eliminada de iCloud`, "success");

    if (state.currentPhotos.length === 0) { closePreview(); return; }
    const nextIdx = Math.min(_previewIndex, state.currentPhotos.length - 1);
    openPreview(nextIdx);
  } catch (e) {
    toast("Error al eliminar: " + e.message, "danger");
  }
}

function toggleThumbs() {
  state.showThumbs = !state.showThumbs;
  const table = document.querySelector("#photos-wrapper table");
  if (table) table.classList.toggle("thumbs-on", state.showThumbs);
  const btn = document.getElementById("btn-thumbs");
  if (btn) btn.classList.toggle("active", state.showThumbs);
  // Lazy: activar src de imágenes pendientes al encender
  if (state.showThumbs) {
    document.querySelectorAll(".photo-thumb[data-src]").forEach(img => {
      img.src = img.dataset.src;
      img.removeAttribute("data-src");
    });
  }
  savePrefs();
}

function toggleDeleteAfter(box) {
  const chk = document.getElementById("chk-delete");
  chk.checked = !chk.checked;
  box.classList.toggle("active", chk.checked);
  savePrefs();
}

// ══════════════════════════════════════════════════════════════════════════════
//  START / CANCEL DOWNLOAD
// ══════════════════════════════════════════════════════════════════════════════

async function startDownload() {
  if (state.downloadQueue.length === 0) {
    toast("La cola está vacía. Añade fotos desde Explorar.", "warning");
    return;
  }

  const outputDir   = document.getElementById("inp-outdir").value.trim();
  const deleteAfter = document.getElementById("chk-delete").checked;
  const isAll       = state.downloadQueue[0]?.all === true;

  const albumEntries = isAll ? [] : state.downloadQueue.filter(q => q.type === "album").map(q => q.name);
  const photoItems   = isAll ? [] : state.downloadQueue.filter(q => q.type !== "album" && !q.all).map(q => ({ id: q.id, album: q.album || null }));
  const allPhotos    = isAll;

  try {
    const res  = await apiFetch("/api/download/start", {
      output_dir:   outputDir || null,
      albums:       albumEntries,
      photo_items:  photoItems,
      all_photos:   allPhotos,
      delete_after: deleteAfter,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.isDownloading = true;
    state.results = [];
    state.deletedCount = 0;

    document.getElementById("btn-start").classList.add("d-none");
    document.getElementById("btn-cancel").classList.remove("d-none");
    document.getElementById("btn-clear-queue").disabled = true;
    document.getElementById("progress-panel").classList.remove("d-none");

    log(`Descarga iniciada → ${data.output_dir}`, "info");
    if (deleteAfter) log("⚠ Los ficheros verificados serán borrados de iCloud", "warning");

  } catch (e) {
    toast("Error al iniciar descarga: " + e.message, "danger");
  }
}

async function cancelDownload() {
  await fetch("/api/download/cancel", { method: "POST" });
  log("Cancelando descarga...", "warning");
}

// ══════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO EVENTS
// ══════════════════════════════════════════════════════════════════════════════

socket.on("download_start", d => {
  document.getElementById("s-total").textContent = d.total_bytes_fmt || fmtBytes(d.total_bytes);
  document.getElementById("s-files").textContent = `0 / ${fmtNum(d.total_files)}`;
  log(`Recopilados ${fmtNum(d.total_files)} archivos (${d.total_bytes_fmt || fmtBytes(d.total_bytes)})`, "info");
});

socket.on("file_start", d => {
  document.getElementById("cf-name").textContent = d.filename;
  document.getElementById("cf-pct").textContent  = "0%";
  document.getElementById("cf-bar").style.width  = "0%";
  document.getElementById("cf-downloaded").textContent = "0 B";
  document.getElementById("cf-size").textContent = d.size_fmt || fmtBytes(d.size);
  const dimStr = (d.width && d.height) ? `  ${fmtNum(d.width)}×${fmtNum(d.height)}` : "";
  log(`↓ [${d.file_num}/${d.total_files}] ${d.filename}  (${d.size_fmt || fmtBytes(d.size)})${dimStr}`, "dl");
});

socket.on("progress", d => {
  // File progress
  const fp = d.file_pct ?? Math.round((d.file_downloaded / (d.file_size || 1)) * 100);
  document.getElementById("cf-pct").textContent  = fp + "%";
  document.getElementById("cf-bar").style.width  = fp + "%";
  document.getElementById("cf-downloaded").textContent = fmtBytes(d.file_downloaded);

  // Overall progress
  const tp = d.total_pct ?? Math.round((d.total_downloaded / (d.total_bytes || 1)) * 100);
  document.getElementById("prog-pct").textContent   = tp + "%";
  document.getElementById("prog-bar").style.width   = tp + "%";

  document.getElementById("s-downloaded").textContent = fmtBytes(d.total_downloaded);
  document.getElementById("s-speed").textContent      = d.speed_fmt || fmtBytes(d.speed) + "/s";
  document.getElementById("s-eta").textContent        = fmtETA(d.eta);
  document.getElementById("s-files").textContent      = `${fmtNum(d.completed)} / ${fmtNum(d.total_files)}`;
});

socket.on("file_complete", d => {
  state.results.push({ ...d, type: d.verified ? "ok" : "warn" });

  document.getElementById("s-ok").textContent  = fmtNum(d.completed);
  document.getElementById("s-err").textContent = fmtNum(d.failed);
  document.getElementById("s-files").textContent = `${fmtNum(d.completed + d.failed)} / ${fmtNum(d.total_files)}`;

  if (d.verified) {
    const okDims = (d.width && d.height) ? `  ${fmtNum(d.width)}×${fmtNum(d.height)}` : "";
    log(`✓ ${d.filename}  ${d.size_fmt || fmtBytes(d.size)}${okDims}  ·  ${d.checksum ? d.checksum.slice(0,16) + "…" : ""}`, "success");
  } else {
    log(`⚠ ${d.filename}  VERIFICACIÓN FALLIDA: ${d.error}`, "warning");
  }

  updateResultsBadge();
});

socket.on("file_error", d => {
  state.results.push({ ...d, type: "error", verified: false });
  log(`✗ ${d.filename}  ERROR: ${d.error}`, "error");
  updateResultsBadge();
});

socket.on("file_deleted", d => {
  state.deletedCount++;
  document.getElementById("s-del").textContent = fmtNum(state.deletedCount);
  log(`🗑 ${d.filename} — borrado de iCloud`, "info");
});

socket.on("file_delete_error", d => {
  log(`⚠ No se pudo borrar de iCloud: ${d.filename} — ${d.error}`, "warning");
});

socket.on("download_complete", d => {
  state.isDownloading = false;

  document.getElementById("btn-start").classList.remove("d-none");
  document.getElementById("btn-cancel").classList.add("d-none");
  document.getElementById("btn-clear-queue").disabled = false;

  const bar = document.getElementById("prog-bar");
  bar.classList.remove("progress-bar-striped", "progress-bar-animated");
  bar.classList.add(d.failed > 0 ? "bg-warning" : "bg-success");
  document.getElementById("prog-pct").textContent = "100%";
  bar.style.width = "100%";

  log(`\n✅ DESCARGA COMPLETADA`, "success");
  log(`Verificados: ${fmtNum(d.completed)}  ·  Errores: ${fmtNum(d.failed)}  ·  Directorio: ${d.output_dir}`, "success");

  renderResults();
  showTab("results");
  toast(`Descarga completada: ${fmtNum(d.completed)} archivos verificados`, "success");
  loadStorage();
});

socket.on("status", d => { log(d.message, "info"); });
socket.on("error",  d => {
  log("ERROR: " + d.message, "error");
  toast(d.message, "danger");
});

// ══════════════════════════════════════════════════════════════════════════════
//  RESULTS
// ══════════════════════════════════════════════════════════════════════════════

function updateResultsBadge() {
  const b = document.getElementById("badge-results");
  if (state.results.length > 0) {
    b.classList.remove("d-none");
    b.textContent = fmtNum(state.results.length);
  }
}

function renderResults(filter) {
  const results = filter && filter !== "all"
    ? state.results.filter(r => filter === "ok" ? r.verified : !r.verified)
    : state.results;

  document.getElementById("results-empty").classList.add("d-none");
  document.getElementById("results-summary").classList.remove("d-none");
  document.getElementById("results-table-wrap").classList.remove("d-none");

  const ok   = state.results.filter(r => r.verified).length;
  const fail = state.results.filter(r => !r.verified).length;
  const sz   = state.results.filter(r => r.verified).reduce((s, r) => s + (r.size || 0), 0);

  document.getElementById("rs-ok").textContent   = fmtNum(ok);
  document.getElementById("rs-fail").textContent = fmtNum(fail);
  document.getElementById("rs-size").textContent = fmtBytes(sz);
  document.getElementById("rs-del").textContent  = fmtNum(state.deletedCount);

  // Highlight active filter
  ["all", "ok", "fail"].forEach(f => {
    document.getElementById("rf-" + f).classList.toggle("active", f === (filter || "all"));
  });

  const tbody = document.getElementById("results-tbody");
  tbody.innerHTML = "";

  for (const r of results) {
    const tr = document.createElement("tr");

    const icon = r.verified
      ? `<i class="fas fa-check-circle status-icon-ok" title="Verificado"></i>`
      : r.type === "error"
        ? `<i class="fas fa-times-circle status-icon-fail" title="${escAttr(r.error || '')}"></i>`
        : `<i class="fas fa-exclamation-circle status-icon-warn" title="${escAttr(r.error || '')}"></i>`;

    const icloudBadge = r.deleted_from_icloud
      ? `<span class="badge" style="background:rgba(248,81,73,0.2);color:#f85149;border:1px solid #f85149">
           <i class="fas fa-trash me-1"></i>Borrado
         </span>`
      : `<span class="badge" style="background:rgba(63,185,80,0.15);color:#3fb950;border:1px solid #3fb950">
           <i class="fas fa-cloud me-1"></i>En iCloud
         </span>`;

    const checksum = r.checksum
      ? `<span title="${r.checksum}" style="font-family:monospace;font-size:0.72em">${r.checksum.slice(0,16)}…</span>`
      : r.error
        ? `<span class="text-danger" style="font-size:0.75em">${escHtml(r.error)}</span>`
        : "—";

    const dims = (r.width && r.height) ? `${fmtNum(r.width)}×${fmtNum(r.height)}` : "—";

    tr.innerHTML = `
      <td class="text-center">${icon}</td>
      <td class="text-light small">${escHtml(r.filename || "")}</td>
      <td class="text-muted small">${r.size_fmt || (r.size ? fmtBytes(r.size) : "—")}</td>
      <td class="text-muted small">${dims}</td>
      <td>${checksum}</td>
      <td>${icloudBadge}</td>
      <td class="text-muted small" style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
          title="${escAttr(r.filepath || "")}">${escHtml(r.filepath || "—")}</td>
    `;
    tbody.appendChild(tr);
  }
}

function filterResults(f) {
  renderResults(f);
}

// ══════════════════════════════════════════════════════════════════════════════
//  LOG
// ══════════════════════════════════════════════════════════════════════════════

function log(msg, type = "info") {
  const container = document.getElementById("dl-log");
  const line = document.createElement("div");
  line.className = "log-" + type;
  const t = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  line.textContent = `[${t}] ${msg}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function clearLog() {
  document.getElementById("dl-log").innerHTML = "";
}

// ══════════════════════════════════════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════════════════════════════════════

function toast(msg, type = "info") {
  const el = document.createElement("div");
  const bsType = { info: "secondary", success: "success", warning: "warning", danger: "danger" }[type] || "secondary";
  el.className = `alert alert-${bsType} shadow py-2 px-3 mb-2 small`;
  el.style.cssText = "min-width:220px; max-width:340px; animation: fadeIn 0.2s;";
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ══════════════════════════════════════════════════════════════════════════════
//  TABS
// ══════════════════════════════════════════════════════════════════════════════

function showTab(name) {
  for (const t of ["browse", "download", "results", "albums"]) {
    document.getElementById("tab-" + t).classList.toggle("d-none", t !== name);
    document.getElementById("tbtn-" + t).classList.toggle("active", t === name);
  }
  // Hide back button if navigating to browse directly (not from albums tab)
  if (name === "browse" && !state.fromAlbumsTab) {
    document.getElementById("btn-back-albums").classList.add("d-none");
  }
  if (name !== "browse") {
    state.fromAlbumsTab = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

async function apiFetch(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fmtBytes(b) {
  if (!b || b === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(b);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtNum(n) {
  return Number(n).toLocaleString("es-ES");
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-ES", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function fmtETA(seconds) {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60)   return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} h ${m} min`;
}

function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s) { return escHtml(s); }

// ══════════════════════════════════════════════════════════════════════════════
//  PREVIEW
// ══════════════════════════════════════════════════════════════════════════════

let _previewIndex = -1;

function openPreview(index) {
  _previewIndex = index;
  const photo = state.currentPhotos[index];
  if (!photo) return;

  const modal   = document.getElementById("preview-modal");
  const mediaEl = document.getElementById("preview-media");
  modal.classList.remove("d-none");
  document.body.style.overflow = "hidden";

  const isVideo = photo.media_type && photo.media_type.startsWith("video/");
  const url = `/api/photo/${encodeURIComponent(photo.id)}/preview`;

  if (isVideo) {
    mediaEl.innerHTML = `<video controls autoplay style="max-width:85vw;max-height:80vh;border-radius:4px">
      <source src="${url}" type="${escAttr(photo.media_type)}">
    </video>`;
  } else {
    mediaEl.innerHTML = `<div class="preview-spinner"><div class="spinner-border text-light"></div></div>`;
    fetch(url).then(async r => {
      if (!r.ok) {
        let msg = "Error " + r.status;
        try { const d = await r.json(); if (d.error) msg = d.error; } catch {}
        mediaEl.innerHTML = `<div class="text-danger p-4">${escHtml(msg)}</div>`;
        return;
      }
      const blob = await r.blob();
      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { mediaEl.innerHTML = ""; mediaEl.appendChild(img); };
      img.onerror = () => { mediaEl.innerHTML = `<div class="text-danger p-4">No se pudo renderizar la imagen</div>`; };
      img.src = objUrl;
    }).catch(e => {
      mediaEl.innerHTML = `<div class="text-danger p-4">${escHtml(e.message)}</div>`;
    });
  }

  document.getElementById("preview-filename").textContent = photo.filename;
  document.getElementById("preview-date").textContent     = photo.date ? fmtDate(photo.date) : "";
  document.getElementById("preview-size").textContent     = photo.size_fmt || "";
  document.getElementById("preview-counter").textContent  = `${index + 1} / ${state.currentPhotos.length}`;

  document.querySelector(".preview-prev").style.visibility = index > 0 ? "visible" : "hidden";
  document.querySelector(".preview-next").style.visibility = index < state.currentPhotos.length - 1 ? "visible" : "hidden";
}

function closePreview() {
  const video = document.querySelector("#preview-media video");
  if (video) video.pause();
  document.getElementById("preview-modal").classList.add("d-none");
  document.body.style.overflow = "";
  _previewIndex = -1;
}

function previewNav(dir) {
  const next = _previewIndex + dir;
  if (next >= 0 && next < state.currentPhotos.length) openPreview(next);
}

// Keyboard shortcuts
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "Escape")      { closePreview(); return; }
  if (e.key === "ArrowLeft"  && _previewIndex >= 0) { previewNav(-1); return; }
  if (e.key === "ArrowRight" && _previewIndex >= 0) { previewNav(1);  return; }
  if (e.key === "1") showTab("browse");
  if (e.key === "2") showTab("albums");
  if (e.key === "3") showTab("download");
  if (e.key === "4") showTab("results");
});
