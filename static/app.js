function imgFromGame(g){
  if(!g?.background_image) return "";

  return g.background_image
    .replace("/media/","/media/crop/600/800/")
    .replace("crop/600/400","crop/600/800");
}

function stars(n){
  const full="★".repeat(n);
  const empty="☆".repeat(5-n);
  return full+empty;
}

function cardHTML(game){
  const img=imgFromGame(game);
  const year=(game?.released&&(""+game.released).slice(0,4))||"—";
  const rating=(typeof game.rating==="number"&&game.rating>0)?game.rating.toFixed(1):"—";

  return `
    <div class="card" onclick="location.href='/game/${game.id}'">
      <div class="cover-wrap">
        <img src="${img}" alt="${escapeHtml(game.name)} cover">
      </div>
      <div class="p">
        <div class="title">${escapeHtml(game.name)}</div>
        <div class="meta">
          <span>${year}</span>
          <span>•</span>
          <span>⭐ ${rating}</span>
        </div>
      </div>
    </div>
  `;
}

async function apiGet(url){
  const r=await fetch(url);
  const data=await r.json();
  if(!r.ok) throw new Error(data?.error||"Request failed");
  return data;
}

function removeDuplicateTitles(games){
  const seen=new Set();
  const result=[];

  for(const g of games){
    if(!g.name) continue;

    const baseName=g.name
      .toLowerCase()
      .split(":")[0]
      .split(" - ")[0]
      .replace(/deluxe|ultimate|digital|edition/gi,"")
      .trim();

    if(!seen.has(baseName)){
      seen.add(baseName);
      result.push(g);
    }
  }

  return result;
}

function shuffle(arr){
  return [...arr].sort(()=>Math.random()-0.5);
}

function reviewRowHTML(game){
  return (r)=>`
    <div class="review-card">
      <div class="review-main">
        <div class="pfp">👤</div>
        <div>
          <div class="review-title">${escapeHtml(game.name)}</div>
          <div class="review-meta">
            Logged by <b>${escapeHtml(r.username)}</b>
            <span class="stars">${stars(r.rating)}</span>
          </div>
          <div class="review-body">${escapeHtml(r.body)}</div>
        </div>
      </div>
      <img class="review-cover" src="${imgFromGame(game)}" alt="${escapeHtml(game.name)} cover">
    </div>
  `;
}

async function loadHome(){
  try{
    const trending=await apiGet("/api/trending");
    let list=trending.results||[];
    list=removeDuplicateTitles(list);
    const shuffled=shuffle(list);

    const trendingRow=document.querySelector("#trendingRow");
    const friendsRow=document.querySelector("#friendsRow");
    const reviewsList=document.querySelector("#reviewsList");

    if(trendingRow){
      trendingRow.innerHTML=shuffled.slice(0,8).map(cardHTML).join("");
    }

    if(friendsRow){
      friendsRow.innerHTML=shuffled.slice(8,16).map(cardHTML).join("");
    }

    const first=list[0];
    if(first&&reviewsList){
      const reviews=await apiGet(`/api/reviews/${first.id}`);
      reviewsList.innerHTML=
        (reviews.reviews||[]).length
          ? reviews.reviews.map(reviewRowHTML(first)).join("")
          : `<div class="muted">No reviews yet. Click a game → “Rate or Review”.</div>`;
    }
  }catch(e){
    const trendingRow=document.querySelector("#trendingRow");
    if(trendingRow){
      trendingRow.innerHTML=`<div class="muted">${escapeHtml(e.message)}</div>`;
    }
  }
}

async function loadGamesPage(){
  const popularGrid=document.querySelector("#popularGrid");
  const searchGrid=document.querySelector("#searchGrid");
  const input=document.querySelector("#searchInput");
  const popularSection=document.querySelector("#popularSection");
  const searchSection=document.querySelector("#searchSection");
  const resultsCount=document.querySelector("#resultsCount");
  const yearFilter=document.querySelector("#yearFilter");
  const genreFilter=document.querySelector("#genreFilter");
  const ratingFilter=document.querySelector("#ratingFilter");
  const sortFilter=document.querySelector("#sortFilter");

  let searchResultsRaw=[];
  let activeBaseList=[];

  function getYear(g){
    return (g?.released&&(""+g.released).slice(0,4))||"";
  }

  function getGenres(g){
    return (g.genres||[]).map(x=>x.name).filter(Boolean);
  }

  function populateYearOptions(list){
    if(!yearFilter) return;
    const years=[...new Set(list.map(getYear).filter(Boolean))].sort((a,b)=>Number(b)-Number(a));
    yearFilter.innerHTML=`<option value="">Year</option>`+years.map(y=>`<option value="${y}">${y}</option>`).join("");
  }

  function populateGenreOptions(list){
    if(!genreFilter) return;
    const genres=[...new Set(list.flatMap(getGenres))].sort((a,b)=>a.localeCompare(b));
    genreFilter.innerHTML=`<option value="">Genre</option>`+genres.map(g=>`<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  }

  function applyFilters(list){
    let filtered=[...list];

    const year=yearFilter?.value||"";
    const genre=genreFilter?.value||"";
    const rating=parseFloat(ratingFilter?.value||0);
    const sort=sortFilter?.value||"";

    if(year){
      filtered=filtered.filter(g=>getYear(g)===year);
    }

    if(genre){
      filtered=filtered.filter(g=>getGenres(g).includes(genre));
    }

    if(rating){
      filtered=filtered.filter(g=>Number(g.rating||0)>=rating);
    }

    if(sort==="rating_desc"){
      filtered.sort((a,b)=>Number(b.rating||0)-Number(a.rating||0));
    }

    if(sort==="rating_asc"){
      filtered.sort((a,b)=>Number(a.rating||0)-Number(b.rating||0));
    }

    if(sort==="year_desc"){
      filtered.sort((a,b)=>Number(getYear(b)||0)-Number(getYear(a)||0));
    }

    if(sort==="year_asc"){
      filtered.sort((a,b)=>Number(getYear(a)||0)-Number(getYear(b)||0));
    }

    if(sort==="name_asc"){
      filtered.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
    }

    if(sort==="name_desc"){
      filtered.sort((a,b)=>(b.name||"").localeCompare(a.name||""));
    }

    return filtered;
  }

  function renderSearch(){
    if(!input||!searchGrid||!searchSection||!popularSection) return;

    const q=input.value.trim();

    if(!q){
      searchSection.classList.add("is-hidden");
      popularSection.classList.remove("is-hidden");
      searchGrid.innerHTML="";
      if(resultsCount) resultsCount.textContent="";
      return;
    }

    searchSection.classList.remove("is-hidden");
    popularSection.classList.add("is-hidden");

    const filtered=applyFilters(activeBaseList);

    if(!filtered.length){
      searchGrid.innerHTML=`<div class="muted">No games found.</div>`;
      if(resultsCount) resultsCount.textContent="0 results";
      return;
    }

    searchGrid.innerHTML=filtered.map(cardHTML).join("");
    if(resultsCount){
      resultsCount.textContent=`${filtered.length} result${filtered.length===1?"":"s"}`;
    }

    window.scrollTo({
      top:searchSection.offsetTop-80,
      behavior:"smooth"
    });
  }

  async function runSearch(q){
    if(!searchGrid||!searchSection||!popularSection) return;

    if(!q){
      activeBaseList=[];
      renderSearch();
      return;
    }

    searchGrid.innerHTML=`<div class="muted">Searching...</div>`;
    searchSection.classList.remove("is-hidden");
    popularSection.classList.add("is-hidden");

    try{
      const res=await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
      let list=res.results||[];
      list=removeDuplicateTitles(list);

      searchResultsRaw=list;
      activeBaseList=[...searchResultsRaw];

      populateYearOptions(searchResultsRaw);
      populateGenreOptions(searchResultsRaw);
      renderSearch();
    }catch(e){
      searchGrid.innerHTML=`<div class="muted">${escapeHtml(e.message)}</div>`;
      if(resultsCount) resultsCount.textContent="";
    }
  }

  try{
    const popular=await apiGet("/api/trending");
    let list=popular.results||[];
    list=removeDuplicateTitles(list);
    list=shuffle(list);

    if(popularGrid){
      popularGrid.innerHTML=list.slice(0,12).map(cardHTML).join("");
    }
  }catch(e){
    if(popularGrid){
      popularGrid.innerHTML=`<div class="muted">${escapeHtml(e.message)}</div>`;
    }
  }

  if(searchSection){
    searchSection.classList.add("is-hidden");
  }

  if(!input) return;

  let t=null;

  input.addEventListener("input",()=>{
    clearTimeout(t);
    t=setTimeout(()=>runSearch(input.value.trim()),250);
  });

  [yearFilter,genreFilter,ratingFilter,sortFilter].forEach(el=>{
    if(!el) return;
    el.addEventListener("change",()=>{
      activeBaseList=[...searchResultsRaw];
      renderSearch();
    });
  });
}

async function loadGameDetail(gameId){
  const hero=document.querySelector("#hero");
  const cover=document.querySelector("#cover");
  const title=document.querySelector("#title");
  const subline=document.querySelector("#subline");
  const desc=document.querySelector("#desc");
  const score=document.querySelector("#score");
  const starsEl=document.querySelector("#stars");
  const bars=document.querySelector("#bars");
  const reviews=document.querySelector("#reviews");

  const addBtn=document.querySelector("#addBtn");
  const reviewBtn=document.querySelector("#reviewBtn");
  const playLaterBtn=document.querySelector("#playLaterBtn");

  try{
    const g=await apiGet(`/api/game/${gameId}`);

    if(hero) hero.style.backgroundImage=`url('${imgFromGame(g)}')`;
    if(cover) cover.src=imgFromGame(g);
    if(title) title.textContent=g.name;

    const dev=g.developers?.[0]?.name||"Unknown studio";
    const year=(g.released&&(""+g.released).slice(0,4))||"—";
    if(subline) subline.textContent=`${year} • ${dev}`;

    if(desc){
      desc.textContent=g.description_raw||"No description available.";
    }

    const views=document.querySelector("#views");
    const likes=document.querySelector("#likes");

    if(views) views.textContent=Math.floor((g.added||1200)/2)+"k";
    if(likes) likes.textContent=Math.floor((g.added||900)/3)+"k";

    const rating=g.rating||0;
    if(score) score.textContent=rating?rating.toFixed(1):"—";
    if(starsEl){
      starsEl.textContent=rating?stars(Math.max(1,Math.min(5,Math.round(rating)))):"";
    }

    if(bars){
      bars.innerHTML="";
      const base=rating||3.5;

      for(let i=0;i<10;i++){
        const h=Math.max(10,Math.min(90,Math.round((Math.sin(i/2)+1)*30+base*8)));
        const div=document.createElement("div");
        div.className="bar";
        div.style.height=h+"px";
        bars.appendChild(div);
      }
    }

    if(reviews){
      const rr=await apiGet(`/api/reviews/${gameId}`);
      reviews.innerHTML=(rr.reviews||[]).length
        ? rr.reviews.map(r=>`
            <div class="review-card">
              <div class="review-main">
                <div class="pfp">👤</div>
                <div>
                  <div class="review-meta">
                    Logged by <b>${escapeHtml(r.username)}</b>
                    <span class="stars">${stars(r.rating)}</span>
                  </div>
                  <div class="review-body">${escapeHtml(r.body)}</div>
                </div>
              </div>
            </div>
          `).join("")
        : `<div class="muted">No reviews yet — be the first.</div>`;
    }

    if(reviewBtn){
      reviewBtn.onclick=()=>{location.href=`/review/${gameId}`;};
    }

    if(playLaterBtn){
      playLaterBtn.onclick=async()=>{
        await quickAddToDefaultList(g);
        alert("Added to Play Later!");
      };
    }

    if(addBtn){
      addBtn.onclick=async()=>{
        await openAddToListModal(g);
      };
    }
  }catch(e){
    if(title) title.textContent="Failed to load game";
    if(desc) desc.textContent=e.message;
  }
}

async function loadReviewPage(gameId){
  const cover=document.querySelector("#cover");
  const title=document.querySelector("#title");
  const body=document.querySelector("#body");
  const publish=document.querySelector("#publish");
  const starPicker=document.querySelector("#starPicker");

  let rating=5;

  try{
    const g=await apiGet(`/api/game/${gameId}`);
    if(cover) cover.src=imgFromGame(g);
    if(title) title.textContent=g.name;
  }catch(_){}

  function renderStars(){
    if(!starPicker) return;

    starPicker.innerHTML="";

    for(let i=1;i<=5;i++){
      const b=document.createElement("button");
      b.className="star-btn"+(i<=rating?" on":"");
      b.type="button";
      b.textContent=i<=rating?"★":"☆";
      b.onclick=()=>{
        rating=i;
        renderStars();
      };
      starPicker.appendChild(b);
    }
  }

  renderStars();

  if(publish){
    publish.onclick=async()=>{
      const text=body?.value.trim()||"";

      if(text.length<3){
        alert("Write a little more.");
        return;
      }

      const r=await fetch(`/api/reviews/${gameId}`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({rating,body:text})
      });

      const data=await r.json();
      if(!r.ok){
        alert(data.error||"Failed");
        return;
      }

      location.href=`/game/${gameId}`;
    };
  }
}

async function loadProfilePage(){
  const data=await apiGet("/api/my/lists");

  const totalLists=document.querySelector("#totalLists");
  const totalReviews=document.querySelector("#totalReviews");

  if(totalLists) totalLists.textContent=(data.lists||[]).length;
  if(totalReviews) totalReviews.textContent="—";

  try{
    const trending=await apiGet("/api/trending");
    let arr=trending.results||[];
    arr=removeDuplicateTitles(arr);
    arr=shuffle(arr);

    const favRow=document.querySelector("#favRow");
    const recentRow=document.querySelector("#recentRow");
    const recentReviews=document.querySelector("#recentReviews");

    if(favRow) favRow.innerHTML=arr.slice(0,4).map(cardHTML).join("");
    if(recentRow) recentRow.innerHTML=arr.slice(2,6).map(cardHTML).join("");
    if(recentReviews){
      recentReviews.innerHTML=`<div class="muted">Open a game and post a review to populate this.</div>`;
    }
  }catch(_){}
}

/* ---------- ADD TO LIST HELPERS ---------- */

async function quickAddToDefaultList(game){
  const data=await apiGet("/api/my/lists");
  const playLater=
    (data.lists||[]).find(l=>l.name.toLowerCase()==="play later")||
    (data.lists||[])[0];

  if(!playLater) throw new Error("No lists found");

  await fetch("/api/my/lists/add",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      list_id:playLater.id,
      game_id:String(game.id),
      game_name:game.name,
      game_cover:imgFromGame(game)
    })
  });
}

async function openAddToListModal(game){
  const data=await apiGet("/api/my/lists");
  const lists=data.lists||[];

  if(!lists.length){
    alert("No lists yet. Go to Lists and create one.");
    return;
  }

  const wrap=document.createElement("div");
  wrap.className="modal-backdrop";
  wrap.innerHTML=`
    <div class="modal">
      <h3>Add to List</h3>
      <input id="listNameInput" placeholder="Type list name exactly..." />
      <div class="muted" style="margin-top:8px;">
        ${lists.map(l=>`• ${escapeHtml(l.name)}`).join("<br>")}
      </div>
      <div class="modal-actions">
        <button class="secondary-btn" id="cancelListBtn">Cancel</button>
        <button class="primary-btn" id="saveListBtn">Add</button>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  const input=wrap.querySelector("#listNameInput");
  const cancelBtn=wrap.querySelector("#cancelListBtn");
  const saveBtn=wrap.querySelector("#saveListBtn");

  cancelBtn.onclick=()=>wrap.remove();
  wrap.onclick=(e)=>{
    if(e.target===wrap) wrap.remove();
  };

  saveBtn.onclick=async()=>{
    const name=input.value.trim();
    if(!name) return;

    const selected=lists.find(
      l=>l.name.toLowerCase()===name.toLowerCase()
    );

    if(!selected){
      alert("List not found.");
      return;
    }

    await fetch("/api/my/lists/add",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        list_id:selected.id,
        game_id:String(game.id),
        game_name:game.name,
        game_cover:imgFromGame(game)
      })
    });

    wrap.remove();
    alert(`Added to ${selected.name}!`);
  };
}

/* ---------- LISTS PAGE ---------- */

async function loadListsPage(){
  const grid=document.querySelector("#listsGrid");
  const btn=document.querySelector("#createListBtn");
  if(!grid||!btn) return;

  async function refresh(){
    grid.innerHTML=`<div class="muted">Loading...</div>`;
    const data=await apiGet("/api/my/lists");
    const lists=data.lists||[];

    if(!lists.length){
      grid.innerHTML=`<div class="muted">No lists yet. Click “Create List +”.</div>`;
      return;
    }

    grid.innerHTML=lists.map(l=>{
      const imgs=(l.items||[]).slice(0,3).map(x=>x.game_cover).filter(Boolean);
      const c1=imgs[0]||"https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=400&q=60";
      const c2=imgs[1]||c1;
      const c3=imgs[2]||c1;

      return `
        <div class="list-card">
          <div class="list-covers">
            <img class="c1" src="${c1}" alt="">
            <img class="c2" src="${c2}" alt="">
            <img class="c3" src="${c3}" alt="">
          </div>
          <div class="list-name">${escapeHtml(l.name)}</div>
          <div class="list-count">${(l.items||[]).length} games</div>
        </div>
      `;
    }).join("");
  }

  function openModal(){
    const wrap=document.createElement("div");
    wrap.className="modal-backdrop";
    wrap.innerHTML=`
      <div class="modal">
        <h3>Create List</h3>
        <input id="newListName" placeholder="List name (ex: Best RPGs)" />
        <div class="modal-actions">
          <button class="secondary-btn" id="cancelBtn">Cancel</button>
          <button class="primary-btn" id="saveBtn">Create</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    wrap.querySelector("#cancelBtn").onclick=()=>wrap.remove();
    wrap.onclick=(e)=>{
      if(e.target===wrap) wrap.remove();
    };

    wrap.querySelector("#saveBtn").onclick=async()=>{
      const name=wrap.querySelector("#newListName").value.trim();
      if(!name) return;

      await fetch("/api/my/lists",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({name})
      });

      wrap.remove();
      refresh();
    };
  }

  btn.addEventListener("click",openModal);
  await refresh();
}

/* ---------- UTILS ---------- */

function escapeHtml(str){
  return (str||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
