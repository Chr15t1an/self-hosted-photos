// Photos web UI: browse a space, filter, lightbox, tag / archive / social_ok, upload (R2 multipart via the Worker).
const $ = (s) => document.querySelector(s);
const state = {
  space: localGet("space") || "family", tag: "", social: "", archived: false, items: [], next: null, open: -1,
  view: "browse", // browse | groups | group (from the URL hash: "", #groups, #group/<id>)
  group: null, // the open group's summary in the group view
  selecting: false, selected: new Map(), // multi-select: id → item, in the order picked (survives filter changes)
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) ? { "content-type": "application/json" } : {}), ...opts.headers } });
  if (res.status === 401 || res.status === 403) { location.reload(); throw new Error("signed out"); }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

// ── Browse ──
let loading = 0; // generation of the newest load; a stale or doubled "more" request is dropped
async function load(append = false) {
  if (state.view === "groups") return; // the group list has its own loader
  if (state.view === "group") { if (!append) await loadGroup(); return; }
  if (append && (!state.next || state.loadingMore)) return;
  const gen = append ? loading : ++loading;
  if (append) state.loadingMore = true;
  else state.next = null; // the old filter's cursor must not page into the new filter's list
  const q = new URLSearchParams({ space: state.space });
  if (state.tag) q.set("tag", state.tag);
  if (state.social) q.set("social", state.social);
  if (state.archived) q.set("archived", "1");
  if (append && state.next) q.set("cursor", state.next);
  let data;
  try { data = await api(`/api/items?${q}`); } finally { if (append) state.loadingMore = false; }
  if (gen !== loading) return; // filters changed while this page was in flight
  const from = append ? state.items.length : 0;
  state.items = append ? state.items.concat(data.items) : data.items;
  state.next = data.next;
  render(append ? from : 0);
  rearmMore();
}

async function loadTags() {
  const { tags } = await api(`/api/tags?space=${state.space}`);
  const sel = $("#tag");
  sel.innerHTML = `<option value="">All tags</option>` + tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.n})</option>`).join("");
  if (!tags.some((t) => t.tag === state.tag)) state.tag = "";
  sel.value = state.tag;
  $("#taglist").innerHTML = tags.map((t) => `<option value="${esc(t.tag)}">`).join("");
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "▶");
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

// from > 0 appends only the new tiles, so the photos already on screen are not rebuilt or re-fetched.
function render(from = 0) {
  document.querySelectorAll(".spaces button").forEach((b) => b.classList.toggle("active",
    state.view === "browse" ? b.dataset.space === state.space : b.dataset.view === "groups"));
  const grid = $("#grid");
  const html = state.items.slice(from).map((it, j) => {
    const i = from + j;
    const src = it.has_thumb ? `/thumb/${it.id}` : it.kind === "photo" ? `/media/${it.id}` : "";
    return `<button class="tile${state.selected.has(it.id) ? " sel" : ""}" data-i="${i}" data-id="${it.id}" title="${esc(it.filename)}">${src ? `<img loading="lazy" src="${src}" alt="">` : `<span class="noimg">${esc(it.filename)}</span>`}${it.kind === "video" ? `<span class="badge dur">${fmtDur(it.duration)}</span>` : ""}${it.social_ok ? `<span class="badge soc">social</span>` : ""}</button>`;
  }).join("");
  if (from) grid.insertAdjacentHTML("beforeend", html); else grid.innerHTML = html;
  $("#empty").hidden = state.items.length > 0;
  $("#empty").textContent = state.view === "group"
    ? "This group is empty. Go to Family or Library, tap Select, pick photos and Add to group."
    : "Nothing here yet. Upload photos or videos with the button above, or with the CLI for big files.";
  $("#more").hidden = !state.next;
  const n = state.items.length;
  $("#end").hidden = !!state.next || n === 0;
  $("#end").textContent = `That's all ${n.toLocaleString()} ${n === 1 ? "item" : "items"}.`;
}

// ── Lightbox ──
function openAt(i) {
  state.open = i;
  const it = state.items[i];
  if (!it) return;
  const media = $("#lb-media");
  media.innerHTML = it.kind === "video"
    ? `<video controls playsinline preload="metadata" src="/media/${it.id}" ${it.has_thumb ? `poster="/thumb/${it.id}"` : ""}></video>`
    : `<img src="${it.has_web ? `/web/${it.id}` : `/media/${it.id}`}" alt="">`;
  // A missing or broken web version falls back to the original once.
  const img = media.querySelector("img");
  if (img) img.addEventListener("error", () => { if (!img.src.endsWith(`/media/${it.id}`)) img.src = `/media/${it.id}`; }, { once: true });
  fillSide(it);
  const dlg = $("#lightbox");
  if (!dlg.open) dlg.showModal();
}

function fillSide(it) {
  $("#lb-name").textContent = it.filename;
  const when = it.captured_at ? new Date(it.captured_at).toLocaleString() : "unknown date";
  const dims = it.width && it.height ? ` · ${it.width}×${it.height}` : "";
  $("#lb-meta").textContent = `${when}${it.captured_src ? ` (${it.captured_src})` : ""}\n${it.kind} · ${fmtSize(it.size)}${dims}${it.duration ? ` · ${fmtDur(it.duration)}` : ""}\n${it.space === "family" ? "Family" : "Library"}${it.archived ? " · archived" : ""}`;
  $("#lb-tags").innerHTML = it.tags.map((t) => `<span class="chip">${esc(t)}<button data-tag="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join("");
  const soc = $("#lb-social");
  soc.checked = it.social_ok;
  soc.disabled = it.space === "family";
  $("#lb-social-note").hidden = it.space !== "family";
  $("#lb-archive").textContent = it.archived ? "Unarchive" : "Archive";
  $("#lb-move").textContent = it.space === "family" ? "Move to Library" : "Move to Family";
  $("#lb-download").href = `/media/${it.id}?download=1`;
}

async function update(fn) {
  const it = state.items[state.open];
  const fresh = await fn(it);
  Object.assign(it, fresh);
  fillSide(it);
  state.dirty = true;
}

$("#lb-tagform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#lb-tag").value.trim();
  if (!v) return;
  $("#lb-tag").value = "";
  await update((it) => api(`/api/items/${it.id}/tags`, { method: "POST", body: JSON.stringify({ tags: v.split(",") }) }));
  loadTags();
});
$("#lb-tags").addEventListener("click", async (e) => {
  const t = e.target.closest("button[data-tag]")?.dataset.tag;
  if (t) { await update((it) => api(`/api/items/${it.id}/tags/${encodeURIComponent(t)}`, { method: "DELETE" })); loadTags(); }
});
$("#lb-social").addEventListener("change", (e) => update((it) => api(`/api/items/${it.id}`, { method: "PATCH", body: JSON.stringify({ social_ok: e.target.checked }) })).catch((err) => { alert(err.message); e.target.checked = !e.target.checked; }));
$("#lb-archive").addEventListener("click", () => update((it) => api(`/api/items/${it.id}`, { method: "PATCH", body: JSON.stringify({ archived: !it.archived }) })));
$("#lb-delete").addEventListener("click", async () => {
  const it = state.items[state.open];
  if (!confirm(`Delete "${it.filename}" permanently? The original file is removed and this can't be undone.`)) return;
  try {
    await api(`/api/items/${it.id}`, { method: "DELETE" });
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
    return;
  }
  state.items = state.items.filter((x) => x.id !== it.id);
  state.dirty = true;
  $("#lightbox").close();
});
$("#lb-move").addEventListener("click", () => {
  const it = state.items[state.open];
  const to = it.space === "family" ? "library" : "family";
  if (to === "family" && it.social_ok && !confirm("Moving to Family takes it out of the social pool. Continue?")) return;
  update(() => api(`/api/items/${it.id}`, { method: "PATCH", body: JSON.stringify({ space: to }) }));
});
const close = () => { $("#lightbox").close(); };
// Closing keeps the pages already loaded (reloading here reset the grid to page 1, and "Load more" then
// fetched page 2 a second time). Items edited out of the current filter drop out of the grid instead.
const matches = (it) => state.view === "group" || it.space === state.space && (state.archived ? it.archived : !it.archived)
  && (!state.tag || it.tags.includes(state.tag)) && (state.social === "" || !!it.social_ok === (state.social === "1"));
$("#lightbox").addEventListener("close", () => {
  $("#lb-media").innerHTML = ""; state.open = -1;
  if (!state.dirty) return;
  state.dirty = false;
  state.items = state.items.filter(matches);
  if (state.view === "group") $("#group-name").textContent = `${state.group.name} · ${state.items.length}`;
  render();
  loadTags();
});
$("#lb-close").addEventListener("click", close);
$("#lb-prev").addEventListener("click", () => openAt(Math.max(0, state.open - 1)));
$("#lb-next").addEventListener("click", () => openAt(Math.min(state.items.length - 1, state.open + 1)));
document.addEventListener("keydown", (e) => {
  if (!$("#lightbox").open || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") $("#lb-prev").click();
  if (e.key === "ArrowRight") $("#lb-next").click();
});
$("#grid").addEventListener("click", (e) => {
  const t = e.target.closest(".tile");
  if (!t) return;
  if (state.selecting) toggleSel(t); else openAt(Number(t.dataset.i));
});

// ── Filters ──
document.querySelectorAll(".spaces button[data-space]").forEach((b) => b.addEventListener("click", () => {
  state.space = b.dataset.space; localSet("space", state.space); state.tag = "";
  if (state.view !== "browse") { location.hash = ""; return; } // route() loads the space
  endSelect(); loadTags(); load();
}));
$(".spaces button[data-view=groups]").addEventListener("click", () => { location.hash = "groups"; });
$("#tag").addEventListener("change", (e) => { state.tag = e.target.value; load(); });
$("#social").addEventListener("change", (e) => { state.social = e.target.value; load(); });
$("#archived").addEventListener("change", (e) => { state.archived = e.target.checked; load(); });
$("#more").addEventListener("click", () => load(true));
// Scrolling near the bottom loads the next page on its own; the button stays as a fallback.
// Re-observed after each page: a page too short to push #more out of the margin would otherwise never re-fire.
const moreObs = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(true); }, { rootMargin: "800px" });
function rearmMore() { moreObs.unobserve($("#more")); if (state.next) moreObs.observe($("#more")); }

// ── Upload ──
$("#files").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const space = state.space; // the space at the moment of picking; switching tabs mid-batch must not move the rest
  const tags = parseTags($("#upload-tags").value); // applied to every file in this batch
  const box = $("#uploads");
  box.hidden = false;
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${esc(f.name)}</span><progress max="1" value="0"></progress><span>0%</span>`;
    box.append(row);
    try {
      const note = await uploadFile(f, space, tags, (p) => { row.children[1].value = p; row.children[2].textContent = `${Math.round(p * 100)}%`; });
      row.children[2].textContent = note ? "skipped" : "done";
      if (note) row.title = note;
    } catch (err) {
      row.children[2].textContent = "failed";
      row.title = err.message;
      console.error(err);
    }
  }
  await Promise.all([load(), loadTags()]);
  setTimeout(() => { box.innerHTML = ""; box.hidden = true; }, 4000);
});

const parseTags = (v) => v.split(",").map((t) => t.trim()).filter(Boolean);

async function uploadFile(file, space, tags, onProgress) {
  const { item } = await api(`/api/exists?filename=${encodeURIComponent(file.name)}&size=${file.size}`);
  if (item?.status === "ready") { onProgress(1); return "already uploaded"; }
  const isVideo = file.type.startsWith("video/");
  const meta = isVideo ? await videoMeta(file) : await photoMeta(file);
  const start = await api("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, size: file.size, content_type: file.type || "", space, tags, ...meta.fields }),
  });
  const parts = [];
  try {
    for (let n = 1, off = 0; off < file.size; n++, off += start.part_size) {
      const blob = file.slice(off, Math.min(off + start.part_size, file.size));
      parts.push(await api(`/api/uploads/${start.id}/parts/${n}`, { method: "PUT", body: blob }));
      onProgress(Math.min(1, (off + blob.size) / file.size) * 0.98);
    }
    await api(`/api/uploads/${start.id}/complete`, { method: "POST", body: JSON.stringify({ parts }) });
  } catch (err) {
    await api(`/api/uploads/${start.id}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
  if (meta.thumb) await api(`/api/items/${start.id}/thumb`, { method: "PUT", body: meta.thumb, headers: { "content-type": "image/jpeg" } }).catch(console.warn);
  if (meta.web) await api(`/api/items/${start.id}/web`, { method: "PUT", body: meta.web, headers: { "content-type": "image/jpeg" } }).catch(console.warn);
  onProgress(1);
}

// Derived JPEGs, made here at upload (not by Cloudflare Images): 480 px for the grid, ~2048 px for the lightbox.
const THUMB = 480;
const WEB = 2048;
const WEB_FALLBACK = 1600; // a grainy shot over the 1 MB budget at 2048 px is redone at 1600 px
const WEB_BUDGET = 1024 * 1024;
function toJpeg(source, w, h, max, quality) {
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; // JPEG has no alpha: transparent pixels would turn black
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", quality));
}
const toThumb = (source, w, h) => toJpeg(source, w, h, THUMB, 0.8);

async function photoMeta(file) {
  const fields = {};
  const exif = await exifDate(file).catch(() => null);
  if (exif) Object.assign(fields, { captured_at: exif, captured_src: "exif" });
  else Object.assign(fields, { captured_at: new Date(file.lastModified).toISOString(), captured_src: "mtime" });
  let thumb = null, web = null;
  try {
    const bmp = await createImageBitmap(file); // honours EXIF orientation
    try {
      Object.assign(fields, { width: bmp.width, height: bmp.height });
      thumb = await toThumb(bmp, bmp.width, bmp.height);
      // No web version for GIFs: the lightbox shows the original so an animation keeps playing.
      if (file.type !== "image/gif") {
        web = await toJpeg(bmp, bmp.width, bmp.height, WEB, 0.82);
        if (web && web.size > WEB_BUDGET) web = await toJpeg(bmp, bmp.width, bmp.height, WEB_FALLBACK, 0.82);
      }
    } finally { bmp.close(); }
  } catch { /* e.g. HEIC on a browser that can't decode it: no thumbnail, the grid shows the name */ }
  return { fields, thumb, web };
}

function videoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    const fields = { captured_at: new Date(file.lastModified).toISOString(), captured_src: "mtime" };
    const done = (thumb) => { URL.revokeObjectURL(url); resolve({ fields, thumb }); };
    const timer = setTimeout(() => done(null), 15000);
    v.addEventListener("loadedmetadata", () => {
      Object.assign(fields, { width: v.videoWidth, height: v.videoHeight, duration: v.duration || null });
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
    });
    v.addEventListener("seeked", async () => { clearTimeout(timer); done(await toThumb(v, v.videoWidth, v.videoHeight).catch(() => null)); });
    v.addEventListener("error", () => { clearTimeout(timer); done(null); });
    mp4Date(file).then((d) => { if (d) Object.assign(fields, { captured_at: d, captured_src: "video" }); }).catch(() => {});
  });
}

// Minimal EXIF reader: JPEG APP1 → TIFF → ExifIFD DateTimeOriginal (0x9003). Returns ISO (no zone → local time).
async function exifDate(file) {
  const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (buf.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 < buf.byteLength) {
    const marker = buf.getUint16(p), len = buf.getUint16(p + 2);
    if (marker === 0xffe1 && buf.getUint32(p + 4) === 0x45786966) return tiffDate(buf, p + 10);
    p += 2 + len;
  }
  return null;
}
function tiffDate(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o) => v.getUint16(t + o, le), u32 = (o) => v.getUint32(t + o, le);
  const findTag = (ifd, tag) => { const n = u16(ifd); for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; } return -1; };
  const ifd0 = u32(4);
  const exifPtr = findTag(ifd0, 0x8769);
  for (const [ifd, tag] of [[exifPtr >= 0 ? u32(exifPtr + 8) : -1, 0x9003], [ifd0, 0x0132]]) {
    if (ifd < 0) continue;
    const e = findTag(ifd, tag);
    if (e < 0) continue;
    const off = u32(e + 8);
    let s = "";
    for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(t + off + i));
    const m = s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
  }
  return null;
}
// MP4/MOV: moov → mvhd creation_time (seconds since 1904, UTC). Reads the file's head and, failing that, its tail.
async function mp4Date(file) {
  for (const [a, b] of [[0, Math.min(file.size, 4 << 20)], [Math.max(0, file.size - (8 << 20)), file.size]]) {
    const bytes = new Uint8Array(await file.slice(a, b).arrayBuffer());
    for (let i = 0; i < bytes.length - 24; i++) {
      if (bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
        const dv = new DataView(bytes.buffer, i + 4);
        const secs = dv.getUint8(0) === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
        if (secs > 0) { const d = new Date((secs - 2082844800) * 1000); if (d.getFullYear() > 1990) return d.toISOString(); }
        return null;
      }
    }
  }
  return null;
}

// ── Views: browse a space, the group list, one group ──
async function route() {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch { /* a hand-typed bad % escape: use it as is */ }
  const view = h === "groups" ? "groups" : h.startsWith("group/") ? "group" : "browse";
  const changed = view !== state.view || (view === "group" && state.group?.id !== h.slice(6));
  state.view = view;
  if (changed) { endSelect(); loading++; } // a browse page still in flight must not land in a group's grid
  document.body.dataset.view = view;
  $("#groups").hidden = view !== "groups";
  $("#grouphead").hidden = view !== "group";
  $("#grid").hidden = view === "groups";
  if (view === "groups") {
    render();
    for (const id of ["#more", "#end", "#empty"]) $(id).hidden = true;
    return loadGroups();
  }
  if (view === "group") { state.group = { id: h.slice(6), name: "" }; state.items = []; state.next = null; render(); return loadGroup(); }
  state.group = null;
  await loadTags();
  return load();
}

async function loadGroups() {
  const box = $("#groups");
  box.innerHTML = `<p class="meta">Loading…</p>`;
  const { groups } = await api("/api/groups");
  box.innerHTML = groups.length
    ? groups.map((g) => `<a class="gcard" href="#group/${encodeURIComponent(g.id)}">${g.cover ? `<img loading="lazy" src="/thumb/${g.cover}" alt="">` : `<span class="gempty"></span>`}<b>${esc(g.name)}</b><span class="meta">${g.n} ${g.n === 1 ? "item" : "items"}</span></a>`).join("")
    : `<p class="empty">No groups yet. Open Family or Library, tap <b>Select</b>, pick photos, then <b>Add to group</b>.</p>`;
}

async function loadGroup() {
  const id = state.group.id;
  let data;
  try { data = await api(`/api/groups/${encodeURIComponent(id)}`); }
  catch (err) { toast(`Group not found (${err.message})`); location.hash = "groups"; return; }
  if (state.view !== "group" || state.group?.id !== id) return; // navigated away meanwhile
  state.group = data.group;
  state.items = data.items;
  state.next = null;
  $("#group-name").textContent = `${data.group.name} · ${data.items.length}`;
  $("#group-share").disabled = !data.items.length;
  render();
}

$("#group-share").addEventListener("click", () => openShare(state.items, state.group.name));
$("#group-rename").addEventListener("click", async () => {
  const name = prompt("Rename group", state.group.name)?.trim();
  if (!name || name === state.group.name) return;
  await api(`/api/groups/${encodeURIComponent(state.group.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
  loadGroup();
});
$("#group-delete").addEventListener("click", async () => {
  if (!confirm(`Delete the group "${state.group.name}"? The photos stay where they are; only the group goes.`)) return;
  await api(`/api/groups/${encodeURIComponent(state.group.id)}`, { method: "DELETE" });
  toast(`Deleted "${state.group.name}"`);
  location.hash = "groups";
});

// ── Multi-select ──
function startSelect() {
  state.selecting = true;
  document.body.classList.add("selecting");
  $("#select").setAttribute("aria-pressed", "true");
  $("#select").textContent = "Cancel";
  updateSelbar();
}
function endSelect() {
  state.selecting = false;
  state.selected.clear();
  document.body.classList.remove("selecting");
  $("#select").setAttribute("aria-pressed", "false");
  $("#select").textContent = "Select";
  document.querySelectorAll(".tile.sel").forEach((t) => t.classList.remove("sel"));
  $("#selbar").hidden = true;
}
function toggleSel(tile) {
  const id = tile.dataset.id;
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.set(id, state.items[Number(tile.dataset.i)]);
  tile.classList.toggle("sel", state.selected.has(id));
  updateSelbar();
}
function updateSelbar() {
  const n = state.selected.size;
  $("#selbar").hidden = !state.selecting;
  $("#sel-count").textContent = n ? `${n} selected` : "Tap photos to select";
  $("#sel-share").disabled = $("#sel-group").disabled = $("#sel-remove").disabled = !n;
  $("#sel-group").hidden = state.view === "group";
  $("#sel-remove").hidden = state.view !== "group";
}
/** The selected items, in the order they were picked. */
const selectedItems = () => [...state.selected.values()];

$("#select").addEventListener("click", () => (state.selecting ? endSelect() : startSelect()));
$("#sel-done").addEventListener("click", endSelect);
$("#sel-share").addEventListener("click", () => openShare(selectedItems(), state.view === "group" ? state.group.name : "Photos"));
$("#sel-remove").addEventListener("click", async () => {
  const ids = [...state.selected.keys()];
  await api(`/api/groups/${encodeURIComponent(state.group.id)}/remove`, { method: "POST", body: JSON.stringify({ item_ids: ids }) });
  toast(`Removed ${ids.length} from "${state.group.name}"`);
  endSelect();
  loadGroup();
});

// ── Add to group ──
$("#sel-group").addEventListener("click", async () => {
  $("#gd-count").textContent = `${state.selected.size} ${state.selected.size === 1 ? "photo" : "photos"}`;
  $("#gd-name").value = "";
  $("#gd-list").innerHTML = `<p class="meta">Loading groups…</p>`;
  $("#groupdlg").showModal();
  const { groups } = await api("/api/groups");
  $("#gd-list").innerHTML = groups.map((g) => `<button data-id="${esc(g.id)}" data-name="${esc(g.name)}">${esc(g.name)} <span class="meta">${g.n}</span></button>`).join("")
    || `<p class="meta">No groups yet: name one above.</p>`;
});
async function addSelectedTo(path, body, name) {
  const ids = [...state.selected.keys()];
  const res = await api(path, { method: "POST", body: JSON.stringify({ ...body, item_ids: ids }) });
  $("#groupdlg").close();
  endSelect();
  const skipped = ids.length - res.added;
  toast(`Added ${res.added} to "${name}"${skipped ? ` (${skipped} already there)` : ""}`, `#group/${encodeURIComponent(res.group.id)}`);
}
$("#gd-new").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#gd-name").value.trim();
  if (!name) return $("#gd-name").focus();
  const btn = e.submitter || $("#gd-new button");
  if (btn.disabled) return;
  btn.disabled = true;
  addSelectedTo("/api/groups", { name }, name).catch((err) => alert(err.message)).finally(() => { btn.disabled = false; });
});
$("#gd-list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (b) addSelectedTo(`/api/groups/${encodeURIComponent(b.dataset.id)}/items`, {}, b.dataset.name).catch((err) => alert(err.message));
});
$("#gd-cancel").addEventListener("click", () => $("#groupdlg").close());

function toast(msg, href) {
  const t = $("#toast");
  t.innerHTML = `${esc(msg)}${href ? ` <a href="${href}">Open</a>` : ""}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 6000);
}

// ── Share: real files through the device's share sheet (Web Share API level 2) ──
// navigator.share() needs a fresh tap (transient activation), and fetching photos takes longer than that lasts,
// so it runs in two taps: open the sheet (files are fetched), then Share. Big sets go in batches, one tap each.
const SHARE_BATCH = 30; // what WhatsApp takes in one send
const SHARE_BATCH_BYTES = 150 * 1024 * 1024; // all of a batch is held in memory: keep a phone's tab alive with videos/originals
const MAX_SHARE_VIDEO = 200 * 1024 * 1024;
const share = { items: [], title: "", from: 0, to: 0, files: null, gen: 0 };
/** Expected bytes to fetch for an item (web versions are ~0.7 MB; else the original). */
const shareBytes = (it, orig) => (it.kind === "photo" && !orig && it.has_web ? 1024 * 1024 : it.size);
/** End index of the batch starting at `from`: at most SHARE_BATCH items and SHARE_BATCH_BYTES (always at least one). */
function batchEnd(from, orig) {
  let end = from, bytes = 0;
  while (end < share.items.length && end - from < SHARE_BATCH) {
    const b = shareBytes(share.items[end], orig);
    if (end > from && bytes + b > SHARE_BATCH_BYTES) break;
    bytes += b; end++;
  }
  return end;
}

function openShare(items, title) {
  if (!items.length) return;
  Object.assign(share, { items, title, from: 0, files: null });
  $("#sd-orig").checked = false;
  $("#sharedlg").showModal();
  prepareBatch();
}
const shareExt = (name) => name.replace(/\.[A-Za-z0-9]{1,6}$/, "");
async function prepareBatch() {
  const gen = ++share.gen;
  const orig = $("#sd-orig").checked;
  share.to = batchEnd(share.from, orig);
  const batch = share.items.slice(share.from, share.to);
  const many = batch.length < share.items.length;
  const range = many ? ` ${share.from + 1}–${share.from + batch.length} of ${share.items.length}` : ` ${batch.length}`;
  $("#sd-title").textContent = `Share${range} ${share.items.length === 1 ? "item" : "items"}`;
  $("#sd-go").disabled = true;
  $("#sd-go").textContent = "Getting photos ready…";
  const files = [], skipped = [];
  let bytes = 0, done = 0;
  const progress = () => {
    $("#sd-progress").value = done / batch.length;
    $("#sd-status").textContent = `Getting ${done}/${batch.length} ready · ${fmtSize(bytes)}`;
  };
  progress();
  // Four at a time, kept in the picked order.
  const out = new Array(batch.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
    while (next < batch.length) {
      const i = next++;
      const it = batch[i];
      try {
        out[i] = await fetchForShare(it, orig);
        if (out[i]) bytes += out[i].size; else skipped.push(it.filename);
      } catch (err) { skipped.push(it.filename); console.warn(it.filename, err); }
      done++;
      if (gen === share.gen) progress();
    }
  }));
  if (gen !== share.gen) return; // closed, or the originals box changed and a new batch started
  files.push(...out.filter(Boolean));
  share.files = files;
  const note = skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}` : "";
  if (!files.length) { $("#sd-status").textContent = `Nothing could be fetched.${note}`; $("#sd-go").textContent = "Share"; return; }
  const can = navigator.canShare?.({ files });
  $("#sd-status").textContent = `${files.length} ready · ${fmtSize(bytes)}.${note}` +
    (can ? "" : " This browser can't send files to other apps, so they will download instead (use Safari on iPhone or Chrome on Android to share).");
  $("#sd-go").textContent = can ? `Share ${files.length}` : `Download ${files.length}`;
  $("#sd-go").disabled = false;
}
async function fetchForShare(it, orig) {
  if (it.kind === "video") {
    if (it.size > MAX_SHARE_VIDEO) return null; // too big for a share sheet; Download original in the lightbox
    return toFile(`/media/${it.id}`, it.filename, it.content_type);
  }
  if (!orig && it.has_web) return toFile(`/web/${it.id}`, `${shareExt(it.filename)}.jpg`, "image/jpeg");
  return toFile(`/media/${it.id}`, it.filename, it.content_type);
}
async function toFile(url, name, type) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  return new File([blob], name, { type: type || blob.type });
}
$("#sd-orig").addEventListener("change", () => prepareBatch());
// (fetches of a closed or superseded batch finish in the background and are dropped by the gen check)
$("#sd-go").addEventListener("click", async () => {
  const files = share.files;
  if (!files?.length || $("#sd-go").disabled) return;
  const go = $("#sd-go");
  const shared = !!navigator.canShare?.({ files });
  go.disabled = true; // a second tap must not resend this batch or skip the next one
  if (shared) {
    try {
      await navigator.share({ files, title: share.title });
    } catch (err) {
      go.disabled = false;
      if (err.name === "AbortError") return; // closed the share sheet: stay on this batch
      $("#sd-status").textContent = `The share didn't go through (${err.name}: ${err.message}). Try fewer at a time, or tap Share again.`;
      return;
    }
  } else {
    for (const f of files) { // no file sharing here (e.g. Firefox): save them instead
      const a = document.createElement("a");
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  share.from = share.to;
  if (share.from < share.items.length) return prepareBatch();
  $("#sharedlg").close();
  toast(`${shared ? "Shared" : "Downloaded"} ${share.items.length} ${share.items.length === 1 ? "item" : "items"}`);
  if (state.selecting) endSelect();
});
$("#sd-cancel").addEventListener("click", () => $("#sharedlg").close());
$("#sharedlg").addEventListener("close", () => { share.gen++; share.files = null; });
$("#lb-share").addEventListener("click", () => { const it = state.items[state.open]; if (it) openShare([it], it.filename); });

window.addEventListener("hashchange", route);
route();
