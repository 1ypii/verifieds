const API = "";

const state = { users: [], changes: [], query: "", shown: 100 };

const PAGE = 100;

const rows = document.getElementById("rows");
const empty = document.getElementById("empty");
const search = document.getElementById("search");
const more = document.getElementById("more");
const changesList = document.getElementById("changes-list");
const changesEmpty = document.getElementById("changes-empty");

const avatars = new Map();
const pendingAvatars = new Set();

const badge = `<img class="verified-badge" src="badge.png" alt="verified">`;

const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 42 42'%3E%3Ccircle cx='21' cy='16' r='7' fill='%232a3542'/%3E%3Cellipse cx='21' cy='34' rx='12' ry='8' fill='%232a3542'/%3E%3C/svg%3E";

const CHANGE_TEXT = {
  added: "added to the registry",
  unverified: "lost the badge, removed",
  banned: "terminated, removed"
};

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ESC[c]);
}

function ago(date) {
  const days = Math.floor((Date.now() - new Date(date + "T00:00:00Z")) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function row(u) {
  return `<tr data-profile="${u.id}" tabindex="0">
    <td><div class="user-cell">
      <img class="avatar" src="${avatars.get(u.id) || placeholder}" data-id="${u.id}" alt="" loading="lazy">
      <div class="user-names">
        <div class="user-display"><span class="name-text">${esc(u.displayName)}</span>${badge}</div>
        <span class="user-handle">@${esc(u.username)}</span>
      </div>
    </div></td>
    <td class="added-cell">${u.added ? ago(u.added) : "–"}</td>
  </tr>`;
}

function feedRow(c) {
  return `<a class="feed-row" href="https://www.roblox.com/users/${c.id}/profile" target="_blank" rel="noopener">
    <img class="feed-avatar" src="${avatars.get(c.id) || placeholder}" data-id="${c.id}" alt="" loading="lazy">
    <div class="feed-info">
      <div class="feed-user"><span>@${esc(c.username)}</span>${badge}</div>
      <div class="feed-what ${esc(c.type)}">${CHANGE_TEXT[c.type] || esc(c.type)} ${ago(c.date)}</div>
    </div>
  </a>`;
}

function filtered() {
  const q = state.query.toLowerCase();
  if (!q) return state.users;
  return state.users.filter(u => (u.username + " " + u.displayName).toLowerCase().includes(q));
}

function render() {
  const list = filtered();
  const slice = list.slice(0, state.shown);
  rows.innerHTML = slice.map(row).join("");
  const left = list.length - slice.length;
  more.hidden = left <= 0;
  more.textContent = `show ${Math.min(left, 200).toLocaleString()} more of ${left.toLocaleString()}`;
  empty.hidden = list.length > 0;
  loadAvatars(slice.map(u => u.id));
}

function renderStats() {
  document.getElementById("stat-tracked").textContent = state.users.length.toLocaleString();
}

function renderChanges() {
  changesList.innerHTML = state.changes.map(feedRow).join("");
  changesEmpty.hidden = state.changes.length > 0;
  loadAvatars(state.changes.map(c => c.id));
}

function applyAvatars() {
  document.querySelectorAll("img[data-id]").forEach(img => {
    const url = avatars.get(Number(img.dataset.id));
    if (url && img.src !== url) img.src = url;
  });
}

async function loadAvatars(ids) {
  const need = [...new Set(ids)].filter(id => !avatars.has(id) && !pendingAvatars.has(id));
  if (!need.length) return;
  need.forEach(id => pendingAvatars.add(id));
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    try {
      const res = await fetch(`${API}/api/thumbs?ids=${chunk.join(",")}`);
      if (res.ok) {
        const data = await res.json();
        for (const t of data.data) avatars.set(t.targetId, t.imageUrl);
      }
    } catch {}
    chunk.forEach(id => pendingAvatars.delete(id));
    applyAvatars();
  }
}

async function loadData() {
  try {
    const res = await fetch(`${API}/api/data`, { cache: "no-store" });
    const data = await res.json();
    if (data.updated === state.updated) return;
    state.updated = data.updated;
    state.users = data.users.sort((a, b) =>
      (b.added || "").localeCompare(a.added || "") || a.username.localeCompare(b.username)
    );
    state.changes = data.changes || [];
    renderStats();
    render();
    renderChanges();
  } catch {}
}

async function poll() {
  try {
    const res = await fetch(`${API}/api/meta`, { cache: "no-store" });
    const { updated } = await res.json();
    if (updated === state.updated) return;
    await loadData();
  } catch {}
}

setInterval(poll, 60000);

loadData();

function openProfile(e) {
  const tr = e.target.closest("tr[data-profile]");
  if (tr) window.open(`https://www.roblox.com/users/${tr.dataset.profile}/profile`, "_blank", "noopener");
}

rows.addEventListener("click", openProfile);
rows.addEventListener("keydown", e => {
  if (e.key === "Enter") openProfile(e);
});

search.addEventListener("input", e => {
  state.query = e.target.value;
  state.shown = PAGE;
  render();
});

more.addEventListener("click", () => {
  state.shown += 200;
  render();
});
