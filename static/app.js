function imgFromGame(g) {
  // RAWG uses background_image
  return g?.background_image || "";
}

function stars(n) {
  const full = "★".repeat(n);
  const empty = "☆".repeat(5 - n);
  return full + empty;
}

function cardHTML(game) {
  const img = imgFromGame(game);
  const year = (game?.released || "").slice(0,4) || "—";
  return `
    <div class="card" onclick="location.href='/game/${game.id}'">
      <img src="${img}" alt="">
      <div class="p">
        <div class="title">${game.name}</div>
        <div class="meta">${year} • ⭐ ${game.rating?.toFixed?.(1) ?? "—"}</div>
      </div>
    </div>
  `;
}

async function apiGet(url) {
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || "Request failed");
  return data;
}

async function loadHome() {
  try {
    const trending = await apiGet("/api/trending");
    document.querySelector("#trendingRow").innerHTML =
      (trending.results || []).slice(0, 8).map(cardHTML).join("");

    // fake "friends" row by reusing trending slice
    document.querySelector("#friendsRow").innerHTML =
      (trending.results || []).slice(4, 10).map(cardHTML).join("");

    // sample reviews list (uses your DB reviews for a trending game if any exist)
    const first = (trending.results || [])[0];
    if (first) {
      const reviews = await apiGet(`/api/reviews/${first.id}`);
      document.querySelector("#reviewsList").innerHTML =
        (reviews.reviews || []).length
          ? reviews.reviews.map(reviewRowHTML(first)).join("")
          : `<div class="muted">No reviews yet. Click a game → “Rate or Review”.</div>`;
    }
  } catch (e) {
    document.querySelector("#trendingRow").innerHTML = `<div class="muted">${e.message}</div>`;
  }
}

function reviewRowHTML(game) {
  return (r) => `
    <div class="review-card">
      <div class="review-left">
        <div class="pfp">👤</div>
        <div>
          <div class="review-title">${game.name}</div>
          <div class="muted">Logged by <b>${r.username}</b> <span class="stars">${stars(r.rating)}</span></div>
          <div class="review-body">${escapeHtml(r.body)}</div>
        </div>
      </div>
      <img class="review-cover" src="${imgFromGame(game)}" alt="">
    </div>
  `;
}

async function loadGamesPage() {
  const popularGrid = document.querySelector("#popularGrid");
  const searchGrid = document.querySelector("#searchGrid");
  const input = document.querySelector("#searchInput");

  // popular
  try {
    const popular = await apiGet("/api/trending");
    popularGrid.innerHTML = (popular.results || []).slice(0, 12).map(cardHTML).join("");
  } catch (e) {
    popularGrid.innerHTML = `<div class="muted">${e.message}</div>`;
  }

  // search
  let t = null;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { searchGrid.innerHTML = ""; return; }
      try {
        const res = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
        searchGrid.innerHTML = (res.results || []).map(cardHTML).join("");
      } catch (e) {
        searchGrid.innerHTML = `<div class="muted">${e.message}</div>`;
      }
    }, 250);
  });
}

async function loadGameDetail(gameId) {
  const hero = document.querySelector("#hero");
  const cover = document.querySelector("#cover");
  const title = document.querySelector("#title");
  const subline = document.querySelector("#subline");
  const desc = document.querySelector("#desc");
  const score = document.querySelector("#score");
  const starsEl = document.querySelector("#stars");
  const bars = document.querySelector("#bars");
  const reviews = document.querySelector("#reviews");

  const addBtn = document.querySelector("#addBtn");
  const reviewBtn = document.querySelector("#reviewBtn");
  const playLaterBtn = document.querySelector("#playLaterBtn");

  try {
    const g = await apiGet(`/api/game/${gameId}`);

    hero.style.backgroundImage = `url('${imgFromGame(g)}')`;
    cover.src = imgFromGame(g);
    title.textContent = g.name;
    subline.textContent = `${g.released?.slice?.(0,4) || "—"} • ${g.developers?.[0]?.name || "Unknown studio"}`;
    desc.textContent = stripHtml(g.description_raw || g.description || "No description available.");

    // “views/likes” are fake UI numbers like your mockups
    document.querySelector("#views").textContent = Math.floor((g.added || 1200) * 80 / 10) + "k";
    document.querySelector("#likes").textContent = Math.floor((g.added || 900) * 60 / 10) + "k";

    const rating = (g.rating || 0);
    score.textContent = rating ? rating.toFixed(1) : "—";
    starsEl.textContent = rating ? stars(Math.max(1, Math.min(5, Math.round(rating)))) : "";

    // bars: simple fake distribution based on rating
    bars.innerHTML = "";
    const base = rating || 3.5;
    for (let i = 0; i < 10; i++) {
      const h = Math.max(10, Math.min(90, Math.round((Math.sin(i/2)+1) * 30 + base * 8)));
      const div = document.createElement("div");
      div.className = "bar";
      div.style.height = h + "px";
      bars.appendChild(div);
    }

    // reviews from DB
    const rr = await apiGet(`/api/reviews/${gameId}`);
    reviews.innerHTML = (rr.reviews || []).length
      ? rr.reviews.map(r => `
          <div class="review-card">
            <div class="review-left">
              <div class="pfp">👤</div>
              <div>
                <div class="muted">Logged by <b>${r.username}</b> <span class="stars">${stars(r.rating)}</span></div>
                <div class="review-body">${escapeHtml(r.body)}</div>
              </div>
            </div>
          </div>
        `).join("")
      : `<div class="muted">No reviews yet — be the first.</div>`;

    reviewBtn.onclick = () => location.href = `/review/${gameId}`;

    playLaterBtn.onclick = async () => {
      await quickAddToDefaultList(g);
      alert("Added to Play Later!");
    };

    addBtn.onclick = async () => {
      await openAddToListModal(g);
    };

  } catch (e) {
    title.textContent = "Failed to load game";
    desc.textContent = e.message;
  }
}

async function loadReviewPage(gameId) {
  const cover = document.querySelector("#cover");
  const title = document.querySelector("#title");
  const body = document.querySelector("#body");
  const publish = document.querySelector("#publish");
  const starPicker = document.querySelector("#starPicker");

  let rating = 5;

  try {
    const g = await apiGet(`/api/game/${gameId}`);
    cover.src = imgFromGame(g);
    title.textContent = g.name;
  } catch (_) {}

  // build stars
  function renderStars() {
    starPicker.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button");
      b.className = "ghost-btn";
      b.style.width = "auto";
      b.style.padding = "8px 12px";
      b.textContent = (i <= rating) ? "★" : "☆";
      b.onclick = () => { rating = i; renderStars(); };
      starPicker.appendChild(b);
    }
  }
  renderStars();

  publish.onclick = async () => {
    const text = body.value.trim();
    if (text.length < 3) { alert("Write a little more."); return; }

    const r = await fetch(`/api/reviews/${gameId}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ rating, body: text })
    });
    const data = await r.json();
    if (!r.ok) { alert(data.error || "Failed"); return; }

    location.href = `/game/${gameId}`;
  };
}

async function loadListsPage() {
  const grid = document.querySelector("#listsGrid");
  const createBtn = document.querySelector("#createList");

  async function refresh() {
    const data = await apiGet("/api/my/lists");
    grid.innerHTML = (data.lists || []).map(l => `
      <div class="list-card">
        <div class="list-title">${escapeHtml(l.name)}</div>
        <div class="muted">${l.items.length} games</div>
        <div class="list-items">
          ${(l.items || []).slice(0,3).map(it => `<img src="${it.game_cover || ""}" alt="">`).join("")}
        </div>
      </div>
    `).join("") || `<div class="muted">No lists yet.</div>`;
  }

  createBtn.onclick = async () => {
    const name = prompt("List name?");
    if (!name) return;
    const r = await fetch("/api/my/lists", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({name})
    });
    if (!r.ok) return alert("Failed to create list");
    refresh();
  };

  refresh();
}

async function loadProfilePage() {
  // counts from your DB
  const data = await apiGet("/api/my/lists");
  document.querySelector("#totalLists").textContent = (data.lists || []).length;

  // reviews count: quick trick — fetch reviews for a few trending games and count yours is heavier,
  // so we keep it simple: just show “—” if not implemented
  document.querySelector("#totalReviews").textContent = "—";

  // fill rows with trending (nice looking)
  try {
    const trending = await apiGet("/api/trending");
    const arr = (trending.results || []).slice(0, 6);
    document.querySelector("#favRow").innerHTML = arr.slice(0,4).map(cardHTML).join("");
    document.querySelector("#recentRow").innerHTML = arr.slice(2,6).map(cardHTML).join("");
    document.querySelector("#recentReviews").innerHTML =
      `<div class="muted">Open a game and post a review to populate this.</div>`;
  } catch (e) {}
}

/* ---------- add-to-list helpers ---------- */
async function quickAddToDefaultList(game) {
  const data = await apiGet("/api/my/lists");
  const playLater = (data.lists || []).find(l => l.name.toLowerCase() === "play later") || (data.lists || [])[0];
  if (!playLater) throw new Error("No lists found");

  await fetch("/api/my/lists/add", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      list_id: playLater.id,
      game_id: game.id,
      game_name: game.name,
      game_cover: imgFromGame(game)
    })
  });
}

async function openAddToListModal(game) {
  const data = await apiGet("/api/my/lists");
  const lists = data.lists || [];
  if (!lists.length) return alert("No lists yet. Go to Lists and create one.");

  const name = prompt("Type list name to add to:\n" + lists.map(l => `• ${l.name}`).join("\n"));
  if (!name) return;

  const selected = lists.find(l => l.name.toLowerCase() === name.toLowerCase());
  if (!selected) return alert("List not found.");

  await fetch("/api/my/lists/add", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      list_id: selected.id,
      game_id: game.id,
      game_name: game.name,
      game_cover: imgFromGame(game)
    })
  });

  alert(`Added to ${selected.name}!`);
}

/* ---------- utils ---------- */
function stripHtml(s) {
  return (s || "").replace(/<[^>]*>/g, "");
}

function escapeHtml(str) {
  return (str || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
