const SHARDS = 26;
const CHECKED_MAX = 40000;
const CRAWL_SOURCES = 8;
const CANDIDATE_TARGET = 800;
const GROUP_ID = 33306361;
const GROUP_ROLE = 102592061;

async function checkBatch(ids) {
  try {
    const res = await fetch("https://users.roblox.com/v1/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: ids, excludeBannedUsers: true })
    });
    if (!res.ok) return null;
    return (await res.json()).data;
  } catch {
    return null;
  }
}

const LISTED = /UserId:(\d+),Username:"[^"]*",DisplayName:"[^"]*",IsVerified:true,OptedOut:false,HiddenForReview:false,IsBanned:false/g;

async function newestListed() {
  try {
    const res = await fetch("https://robloxverifieds.com/verified");
    if (!res.ok) return [];
    return [...(await res.text()).matchAll(LISTED)].map(m => Number(m[1]));
  } catch {
    return [];
  }
}

async function loadJson(env, key, fallback) {
  const v = await env.DATA.get(key);
  return v ? JSON.parse(v) : fallback;
}

async function tick(env) {
  const st = await loadJson(env, "state", {
    tick: 0, syncShard: 0, sourceCursor: 0, candidates: [], pending: []
  });
  st.tick++;
  const ids = await loadJson(env, "ids", []);
  const tracked = new Set(ids);
  const today = new Date().toISOString().slice(0, 10);
  const newUsers = [];
  const changes = [];
  let renamed = false;

  if (st.tick % 3 !== 0) {
    const checked = new Set(await loadJson(env, "checked", st.checked || []));
    delete st.checked;
    delete st.scanNext;
    const queued = new Set(st.candidates);
    if (st.tick % 6 === 1) {
      for (const id of await newestListed()) {
        if (tracked.has(id) || checked.has(id) || queued.has(id)) continue;
        queued.add(id);
        st.candidates.push(id);
      }
    }
    if (st.tick % 6 === 4) {
      try {
        const cursor = st.groupCursor ? `&cursor=${encodeURIComponent(st.groupCursor)}` : "";
        const res = await fetch(`https://groups.roblox.com/v1/groups/${GROUP_ID}/roles/${GROUP_ROLE}/users?limit=100&sortOrder=Desc${cursor}`);
        if (res.ok) {
          const page = await res.json();
          st.groupCursor = page.nextPageCursor || null;
          for (const m of page.data || []) {
            if (tracked.has(m.userId) || checked.has(m.userId) || queued.has(m.userId)) continue;
            queued.add(m.userId);
            st.candidates.push(m.userId);
          }
        }
      } catch {}
    }
    for (let s = 0; s < CRAWL_SOURCES && st.candidates.length < CANDIDATE_TARGET && ids.length; s++) {
      const source = ids[st.sourceCursor % ids.length];
      st.sourceCursor++;
      try {
        const res = await fetch(`https://friends.roblox.com/v1/users/${source}/friends`);
        if (!res.ok) break;
        for (const f of (await res.json()).data || []) {
          if (tracked.has(f.id) || checked.has(f.id) || queued.has(f.id)) continue;
          queued.add(f.id);
          st.candidates.push(f.id);
        }
      } catch {
        break;
      }
    }
    for (let n = 0; n < 10 && st.candidates.length; n++) {
      const chunk = st.candidates.splice(0, 100);
      const data = await checkBatch(chunk);
      if (!data) {
        st.candidates.unshift(...chunk);
        break;
      }
      for (const u of data) {
        if (u.hasVerifiedBadge && !tracked.has(u.id)) {
          newUsers.push({ id: u.id, username: u.name, displayName: u.displayName, added: today });
          tracked.add(u.id);
        }
      }
      chunk.forEach(id => checked.add(id));
    }
    await env.DATA.put("checked", JSON.stringify([...checked].slice(-CHECKED_MAX)));
  } else {
    const si = st.syncShard % SHARDS;
    st.syncShard++;
    const shard = await loadJson(env, `shard:${si}`, []);
    if (shard.length) {
      const alive = new Map();
      let ok = true;
      for (let i = 0; i < shard.length && ok; i += 100) {
        const data = await checkBatch(shard.slice(i, i + 100).map(u => u.id));
        if (!data) ok = false;
        else for (const u of data) alive.set(u.id, u);
      }
      if (ok) {
        const pending = new Set(st.pending || []);
        let dirty = false;
        const keep = [];
        for (const u of shard) {
          const fresh = alive.get(u.id);
          if (!fresh) {
            if (!pending.has(u.id)) {
              pending.add(u.id);
              keep.push(u);
              continue;
            }
            pending.delete(u.id);
            changes.push({ id: u.id, username: u.username, type: "banned", date: today });
            dirty = true;
            continue;
          }
          pending.delete(u.id);
          if (!fresh.hasVerifiedBadge) {
            changes.push({ id: u.id, username: fresh.name, type: "unverified", date: today });
            dirty = true;
            continue;
          }
          if (u.username !== fresh.name || u.displayName !== fresh.displayName) {
            u.username = fresh.name;
            u.displayName = fresh.displayName;
            dirty = true;
            renamed = true;
          }
          keep.push(u);
        }
        st.pending = [...pending];
        if (dirty) {
          keep.sort((a, b) => a.username.localeCompare(b.username));
          await env.DATA.put(`shard:${si}`, JSON.stringify(keep));
        }
        if (shard.length - keep.length) {
          const gone = new Set(changes.map(c => c.id));
          await env.DATA.put("ids", JSON.stringify(ids.filter(id => !gone.has(id))));
        }
      }
    }
  }

  if (newUsers.length) {
    const byShard = new Map();
    for (const u of newUsers) {
      const si = u.id % SHARDS;
      if (!byShard.has(si)) byShard.set(si, []);
      byShard.get(si).push(u);
      changes.push({ id: u.id, username: u.username, type: "added", date: today });
    }
    for (const [si, users] of byShard) {
      const shard = await loadJson(env, `shard:${si}`, []);
      shard.push(...users);
      shard.sort((a, b) => a.username.localeCompare(b.username));
      await env.DATA.put(`shard:${si}`, JSON.stringify(shard));
    }
    await env.DATA.put("ids", JSON.stringify([...ids, ...newUsers.map(u => u.id)]));
  }

  if (changes.length) {
    const feed = await loadJson(env, "changes", []);
    await env.DATA.put("changes", JSON.stringify([...changes, ...feed].slice(0, 300)));
  }

  await env.DATA.put("state", JSON.stringify(st));
  if (newUsers.length || changes.length || renamed) {
    await env.DATA.put("meta", JSON.stringify({ updated: new Date().toISOString() }));
  }
}

async function apiMeta(env) {
  const meta = await env.DATA.get("meta");
  return new Response(meta || '{"updated":null}', {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=20",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

async function apiData(env) {
  const keys = ["meta", "changes"];
  for (let i = 0; i < SHARDS; i++) keys.push(`shard:${i}`);
  const values = await Promise.all(keys.map(k => env.DATA.get(k)));
  const meta = values[0] || '{"updated":null}';
  const changes = values[1] || "[]";
  const parts = values.slice(2).filter(s => s && s !== "[]").map(s => s.slice(1, -1));
  const body = `{"updated":${JSON.parse(meta).updated ? `"${JSON.parse(meta).updated}"` : "null"},"users":[${parts.join(",")}],"changes":${changes}}`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/data" || url.pathname === "/api/meta") {
      const cache = caches.default;
      const cached = await cache.match(request.url);
      if (cached) return cached;
      const res = url.pathname === "/api/meta" ? await apiMeta(env) : await apiData(env);
      ctx.waitUntil(cache.put(request.url, res.clone()));
      return res;
    }

    if (url.pathname === "/api/thumbs") {
      const ids = url.searchParams.get("ids") || "";
      if (!/^\d+(,\d+)*$/.test(ids) || ids.split(",").length > 100) {
        return new Response("bad ids", { status: 400 });
      }
      const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids}&size=150x150&format=Png&isCircular=false`);
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  }
};
