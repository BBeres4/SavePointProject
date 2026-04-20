

function imgFromGame(g){
  if(!g?.background_image) return "";

  return g.background_image
    .replace("/media/","/media/crop/600/800/")
    .replace("crop/600/400","crop/600/800");
}

function gameCoverHTML(game, className=""){
  const name=game?.name || game?.game_name || `Game #${game?.id || game?.game_id || ""}`;
  const gameId=String(game?.id || game?.game_id || "");
  const rawImg=imgFromGame({
    ...game,
    background_image:game?.background_image || game?.game_cover || ""
  });
  const img=gameId ? `/api/cover/${encodeURIComponent(gameId)}?src=${encodeURIComponent(rawImg)}` : rawImg;
  const cls=className ? ` class="${className}"` : "";

  if(img){
    return `<img${cls} src="${escapeHtml(img)}" alt="${escapeHtml(name)} cover" data-game-id="${escapeHtml(gameId)}" data-game-name="${escapeHtml(name)}" onerror="repairGameCover(this)">`;
  }

  return className
    ? `<div${cls}></div>`
    : `<div class="muted">No cover</div>`;
}

async function repairGameCover(img){
  if(!img || img.dataset.coverRetry === "done") return;

  img.dataset.coverRetry="done";
  const gameId=img.dataset.gameId;
  if(!gameId) return;

  try{
    const game=await apiGet(`/api/game/${encodeURIComponent(gameId)}`);
    const recoveredRaw=imgFromGame(game);
    const recovered=recoveredRaw
      ? `/api/cover/${encodeURIComponent(gameId)}?src=${encodeURIComponent(recoveredRaw)}`
      : "";
    if(recovered && recovered !== img.currentSrc && recovered !== img.src){
      img.src=recovered;
      img.alt=`${game?.name || img.dataset.gameName || "Game"} cover`;
      return;
    }
  }catch(_){}

  const fallback=img.closest(".cover-wrap,.review-card");
  if(fallback && fallback.classList.contains("cover-wrap")){
    fallback.innerHTML=`<div class="muted">No cover</div>`;
    return;
  }

  img.outerHTML=`<div class="review-cover"></div>`;
}

function stars(n){
  const full="★".repeat(n);
  const empty="☆".repeat(5-n);
  return full+empty;
}

function cardHTML(game){
  const year=game?.released_year||((game?.released&&(""+game.released).match(/(19|20)\d{2}/)?.[0]))||"—";
  const rating=(typeof game.rating==="number"&&game.rating>0)?game.rating.toFixed(1):"—";

  return `
    <div class="card" onclick="location.href='/game/${game.id}'">
      <div class="cover-wrap">
        ${gameCoverHTML(game)}
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
      ${gameCoverHTML(game, "review-cover")}
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
    const activityFeed=document.querySelector("#activityFeed");

    if(trendingRow){
      trendingRow.innerHTML=shuffled.slice(0,8).map(cardHTML).join("");
    }

    try{
      const feed=await apiGet("/api/activity/feed");
      if(activityFeed){
        activityFeed.innerHTML=(feed.activities||[]).length
          ? (feed.activities||[]).map(x=>{
              if(x.type==="review"){
                return `
                  <div class="activity-card">
                    <div class="activity-head"><b>${escapeHtml(x.username)}</b> reviewed a game</div>
                    <div class="activity-body">${stars(Number(x.rating||0))} — ${escapeHtml((x.body||"").slice(0,180))}</div>
                    <a class="link" href="/game/${x.game_id}">Open game</a>
                  </div>
                `;
              }
              return `
                <div class="activity-card">
                  <div class="activity-head"><b>${escapeHtml(x.username)}</b> added to Play Later</div>
                  <div class="activity-body">${escapeHtml(x.body||"")}</div>
                  <a class="link" href="/game/${x.game_id}">Open game</a>
                </div>
              `;
            }).join("")
          : `<div class="muted">Follow people to see reviews and Play Later updates here.</div>`;
      }
    }catch(_){
      if(activityFeed){
        activityFeed.innerHTML=`<div class="muted">Could not load activity feed.</div>`;
      }
    }

    initFriendsUI();
  }catch(e){
    const trendingRow=document.querySelector("#trendingRow");
    if(trendingRow){
      trendingRow.innerHTML=`<div class="muted">${escapeHtml(e.message)}</div>`;
    }
  }
}

async function initFriendsUI(){
  const input=document.querySelector("#friendSearchInput");
  const btn=document.querySelector("#friendSearchBtn");
  const results=document.querySelector("#friendSearchResults");
  const pills=document.querySelector("#friendsListPills");
  if(!input||!btn||!results||!pills) return;

  async function loadPills(){
    const data=await apiGet("/api/friends");
    pills.innerHTML=(data.friends||[]).length
      ? data.friends.map(f=>`<span class="friend-pill">${escapeHtml(f.username)}</span>`).join("")
      : `<span class="muted">No friends yet.</span>`;
  }

  async function runSearch(){
    const q=input.value.trim();
    if(q.length<2){
      results.innerHTML=`<div class="muted">Type at least 2 letters.</div>`;
      return;
    }
    const data=await apiGet(`/api/friends/search?q=${encodeURIComponent(q)}`);
    const rows=data.results||[];
    if(!rows.length){
      results.innerHTML=`<div class="muted">No users found.</div>`;
      return;
    }
    results.innerHTML=rows.map(u=>`
      <div class="friend-result-row">
        <div>@${escapeHtml(u.username)}</div>
        <button class="secondary-btn friend-follow-btn" data-id="${u.id}" data-following="${u.following?1:0}">
          ${u.following?"Unfollow":"Follow"}
        </button>
      </div>
    `).join("");

    results.querySelectorAll(".friend-follow-btn").forEach(b=>{
      b.addEventListener("click",async()=>{
        const id=b.dataset.id;
        const following=b.dataset.following==="1";
        await fetch(following?"/api/friends/unfollow":"/api/friends/follow",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({friend_id:id})
        });
        await loadPills();
        await runSearch();
      });
    });
  }

  btn.addEventListener("click",runSearch);
  input.addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){
      e.preventDefault();
      runSearch();
    }
  });
  await loadPills();
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

  // Reset filters on page load so a cached browser selection does not hide all games.
  if(yearFilter) yearFilter.value="";
  if(genreFilter) genreFilter.value="";
  if(ratingFilter) ratingFilter.value="";
  if(sortFilter) sortFilter.value="";

  const defaultYearOptions=[...(yearFilter?.options||[])].map(opt=>({
    value:opt.value,
    label:opt.textContent||opt.value
  }));
  const defaultGenreOptions=[...(genreFilter?.options||[])].map(opt=>({
    value:opt.value,
    label:opt.textContent||opt.value
  }));

  let browseResultsRaw=[];
  let searchResultsRaw=[];
  let trendingResultsRaw=[];
  let activeView="browse";
  let searchRequestId=0;

  function getYear(g){
    if(g?.released_year) return String(g.released_year);
    const m=(""+(g?.released||"")).match(/(19|20)\d{2}/);
    return m?m[0]:"";
  }

  function getGenres(g){
    return (g.genres||[])
      .map(x=>typeof x==="string"?x:x?.name)
      .filter(Boolean);
  }

  function normalizeGenreName(value){
    return (value||"")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g," ")
      .trim();
  }

  function matchesYearFilter(game, yearValue){
    if(!yearValue) return true;

    const gameYear=Number(getYear(game)||0);
    if(!gameYear) return false;

    const rangeMatch=yearValue.match(/^(\d{4})-(\d{4})$/);
    if(rangeMatch){
      const minYear=Number(rangeMatch[1]);
      const maxYear=Number(rangeMatch[2]);
      return gameYear>=minYear&&gameYear<=maxYear;
    }

    return String(gameYear)===yearValue;
  }

  function matchesGenreFilter(game, genreValue){
    if(!genreValue) return true;

    const selected=normalizeGenreName(genreValue);
    const genreAliases={
      action:["action","action adventure","hack and slash","beat em up"],
      adventure:["adventure","action adventure","point and click","interactive fiction"],
      rpg:["rpg","role playing","jrpg","action rpg","crpg","open world rpg"],
      shooter:["shooter","fps","tps","first person shooter","third person shooter"],
      "open world":["open world","sandbox","open world rpg"],
      sports:["sports","football","soccer","basketball","baseball","hockey","golf","tennis","wrestling"],
      racing:["racing","driving","kart racer","automobile sim"],
      fighting:["fighting","beat em up","martial arts"],
      horror:["horror","survival horror","psychological horror"],
      platformer:["platformer","platform"],
      puzzle:["puzzle","logic","match 3"]
    };
    const acceptedTerms=genreAliases[selected]||[selected];
    const gameGenres=getGenres(game).map(normalizeGenreName);

    return gameGenres.some(genreName=>
      acceptedTerms.some(term=>
        genreName===term||genreName.includes(term)||term.includes(genreName)
      )
    );
  }

  function populateYearOptions(list){
    if(!yearFilter) return;
    const selectedValue=yearFilter.value;
    const dynamicYears=[...new Set(list.map(getYear).filter(Boolean))].sort((a,b)=>Number(b)-Number(a));
    const mergedOptions=[...defaultYearOptions];

    dynamicYears.forEach(year=>{
      if(!mergedOptions.some(opt=>opt.value===year)){
        mergedOptions.push({value:year,label:year});
      }
    });

    const placeholderOption=mergedOptions.find(opt=>!opt.value);
    const exactYearOptions=mergedOptions
      .filter(opt=>/^\d{4}$/.test(opt.value))
      .sort((a,b)=>Number(b.value)-Number(a.value));
    const rangeOptions=mergedOptions.filter(opt=>opt.value&&!/^\d{4}$/.test(opt.value));
    const sortedOptions=[
      ...(placeholderOption?[placeholderOption]:[]),
      ...exactYearOptions,
      ...rangeOptions
    ];

    yearFilter.innerHTML=sortedOptions.map(opt=>`<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`).join("");
    yearFilter.value=sortedOptions.some(opt=>opt.value===selectedValue)?selectedValue:"";
  }

  function populateGenreOptions(list){
    if(!genreFilter) return;
    const selectedValue=genreFilter.value;
    const dynamicGenres=[...new Set(list.flatMap(getGenres))].sort((a,b)=>a.localeCompare(b));
    const mergedOptions=[...defaultGenreOptions];

    dynamicGenres.forEach(genre=>{
      if(!mergedOptions.some(opt=>opt.value===genre)){
        mergedOptions.push({value:genre,label:genre});
      }
    });

    genreFilter.innerHTML=mergedOptions.map(opt=>`<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`).join("");
    genreFilter.value=mergedOptions.some(opt=>opt.value===selectedValue)?selectedValue:"";
  }

  function applyFilters(list, query=""){
    let filtered=[...list];

    const normalizedQuery=(query||"").trim().toLowerCase();
    const year=yearFilter?.value||"";
    const genre=genreFilter?.value||"";
    const rating=parseFloat(ratingFilter?.value||0);
    const sort=sortFilter?.value||"";

    if(normalizedQuery){
      filtered=filtered.filter(g=>(g.name||"").toLowerCase().includes(normalizedQuery));
    }

    if(year){
      filtered=filtered.filter(g=>matchesYearFilter(g,year));
    }

    if(genre){
      filtered=filtered.filter(g=>matchesGenreFilter(g,genre));
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

  function hasActiveFilters(){
    return Boolean(
      yearFilter?.value||
      genreFilter?.value||
      ratingFilter?.value||
      sortFilter?.value
    );
  }

  function getActiveSource(){
    const q=input?.value.trim()||"";
    if(q){
      return {
        list:searchResultsRaw,
        query:q,
        view:"search"
      };
    }

    return {
      list:browseResultsRaw,
      query:"",
      view:"browse"
    };
  }

  function syncFilterOptions(){
    const source=getActiveSource();
    populateYearOptions(source.list);
    populateGenreOptions(source.list);
  }

  function renderGamesView(){
    if(!popularGrid||!searchGrid||!popularSection||!searchSection) return;

    const source=getActiveSource();
    const filtered=applyFilters(source.list,source.query);
    const showingSearch=source.view==="search";

    activeView=source.view;
    popularSection.classList.toggle("is-hidden",showingSearch);
    searchSection.classList.toggle("is-hidden",!showingSearch);

    if(showingSearch){
      popularGrid.innerHTML="";

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
      return;
    }

    searchGrid.innerHTML="";
    if(resultsCount) resultsCount.textContent="";

    if(!filtered.length){
      popularGrid.innerHTML=`<div class="muted">No games found.</div>`;
      return;
    }

    popularGrid.innerHTML=filtered.map(cardHTML).join("");
  }

  async function runSearch(q){
    if(!searchGrid||!searchSection||!popularSection) return;

    if(!q){
      searchResultsRaw=[];
      syncFilterOptions();
      renderGamesView();
      return;
    }

    const requestId=++searchRequestId;

    if(resultsCount){
      resultsCount.textContent="Searching...";
    }

    try{
      const res=await apiGet(`/api/search?q=${encodeURIComponent(q)}`);

      if(requestId!==searchRequestId) return;

      let list=res.results||[];
      list=removeDuplicateTitles(list);

      searchResultsRaw=list;
      syncFilterOptions();
      renderGamesView();
    }catch(e){
      if(requestId!==searchRequestId) return;

      activeView="search";
      searchSection.classList.remove("is-hidden");
      popularSection.classList.add("is-hidden");
      searchGrid.innerHTML=`<div class="muted">${escapeHtml(e.message)}</div>`;
      if(resultsCount) resultsCount.textContent="";
    }
  }

  try{
    const [browse,popular]=await Promise.all([
      apiGet("/api/browse"),
      apiGet("/api/trending")
    ]);

    let browseList=removeDuplicateTitles(browse.results||[]);
    let popularList=removeDuplicateTitles(popular.results||[]);

    browseResultsRaw=[...browseList];
    trendingResultsRaw=[...popularList];

    if(!browseResultsRaw.length&&trendingResultsRaw.length){
      browseResultsRaw=[...trendingResultsRaw];
    }

    if(!hasActiveFilters()&&trendingResultsRaw.length){
      browseResultsRaw=[...shuffle(trendingResultsRaw).slice(0,12), ...browseResultsRaw]
        .filter((game,index,list)=>list.findIndex(other=>other.id===game.id)===index);
    }

    syncFilterOptions();
    renderGamesView();
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
    const q=input.value.trim();

    syncFilterOptions();
    renderGamesView();

    t=setTimeout(()=>runSearch(q),250);
  });

  [yearFilter,genreFilter,ratingFilter,sortFilter].forEach(el=>{
    if(!el) return;
    el.addEventListener("change",()=>{
      syncFilterOptions();
      renderGamesView();
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
                  <div class="review-social">
                    <button class="secondary-btn review-like-btn" data-review-id="${r.id}">
                      ${r.liked_by_me ? "💙" : "🤍"} Like (${r.likes_count||0})
                    </button>
                    <button class="secondary-btn review-comments-toggle" data-review-id="${r.id}">
                      💬 Comments (${r.comments_count||0})
                    </button>
                  </div>
                  <div class="review-comments-box" id="comments-${r.id}"></div>
                </div>
              </div>
            </div>
          `).join("")
        : `<div class="muted">No reviews yet — be the first.</div>`;

      reviews.querySelectorAll(".review-like-btn").forEach(btn=>{
        btn.addEventListener("click",async()=>{
          const reviewId=btn.dataset.reviewId;
          const res=await fetch(`/api/review/${reviewId}/like`,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({})
          });
          const data=await res.json();
          btn.textContent=`${data.liked ? "💙":"🤍"} Like (${data.likes_count||0})`;
        });
      });

      reviews.querySelectorAll(".review-comments-toggle").forEach(btn=>{
        btn.addEventListener("click",async()=>{
          const reviewId=btn.dataset.reviewId;
          const box=document.querySelector(`#comments-${reviewId}`);
          if(!box) return;

          if(box.dataset.open==="1"){
            box.innerHTML="";
            box.dataset.open="0";
            return;
          }

          const data=await apiGet(`/api/review/${reviewId}/comments`);
          const comments=data.comments||[];
          box.innerHTML=`
            <div class="review-comments-list">
              ${comments.length
                ? comments.map(c=>`<div class="review-comment"><b>${escapeHtml(c.username)}:</b> ${escapeHtml(c.body)}</div>`).join("")
                : `<div class="muted">No comments yet.</div>`
              }
            </div>
            <div class="review-comment-form">
              <input type="text" class="review-comment-input" placeholder="Write a comment..." />
              <button class="primary-btn review-comment-send">Post</button>
            </div>
          `;
          box.dataset.open="1";
          const sendBtn=box.querySelector(".review-comment-send");
          const input=box.querySelector(".review-comment-input");
          sendBtn?.addEventListener("click",async()=>{
            const text=(input?.value||"").trim();
            if(!text) return;
            await fetch(`/api/review/${reviewId}/comments`,{
              method:"POST",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({body:text})
            });
            btn.click();
            btn.click();
          });
        });
      });
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
  const stats=await apiGet("/api/profile/stats");
  const totalLists=document.querySelector("#totalLists");
  const totalReviews=document.querySelector("#totalReviews");
  const followersCount=document.querySelector("#followersCount");
  const followingCount=document.querySelector("#followingCount");
  const totalGames=document.querySelector("#totalGames");

  if(followersCount) followersCount.textContent=stats.followers ?? 0;
  if(followingCount) followingCount.textContent=stats.following ?? 0;
  if(totalGames) totalGames.textContent=stats.total_games ?? 0;
  if(totalLists) totalLists.textContent=stats.lists ?? 0;
  if(totalReviews) totalReviews.textContent=stats.reviews ?? 0;

  try{
    const profile=await apiGet("/api/profile/content");
    const favorites=profile.favorites||[];
    const recentlyPlayed=profile.recently_played||[];
    const recentlyReviewed=profile.recently_reviewed||[];

    const favRow=document.querySelector("#favRow");
    const recentRow=document.querySelector("#recentRow");
    const recentReviews=document.querySelector("#recentReviews");

    if(favRow){
      favRow.innerHTML=favorites.length
        ? favorites.slice(0,4).map(cardHTML).join("")
        : `<div class="muted">No favorite games yet. Add games to a list named “Favorites”.</div>`;
    }
    if(recentRow){
      recentRow.innerHTML=recentlyPlayed.length
        ? recentlyPlayed.slice(0,4).map(cardHTML).join("")
        : `<div class="muted">No recently played games yet. Add games to a “Recently Played” list.</div>`;
    }
    if(recentReviews){
      recentReviews.innerHTML=recentlyReviewed.length
        ? recentlyReviewed.map(r=>`
            <div class="review-card">
              <div class="review-main">
                <div class="pfp">👤</div>
                <div>
                  <div class="review-title">${escapeHtml(r.game_name || `Game #${r.game_id}`)}</div>
                  <div class="review-meta">
                    Logged by <b>${escapeHtml(r.username || "You")}</b>
                    <span class="stars">${stars(Number(r.rating||0))}</span>
                  </div>
                  <div class="review-body">${escapeHtml(r.body || "")}</div>
                </div>
              </div>
              ${gameCoverHTML({
                id:r.game_id,
                name:r.game_name,
                background_image:r.game_cover
              }, "review-cover")}
            </div>
          `).join("")
        : `<div class="muted">Open a game and post a review to populate this.</div>`;
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

  function listItemCard(item){
    const cover=item.game_cover||"https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=400&q=60";
    return `
      <div class="list-item-card" onclick="location.href='/game/${item.game_id}'">
        <img src="${cover}" alt="${escapeHtml(item.game_name||"Game")} cover">
        <div class="list-item-meta">
          <div class="list-item-name">${escapeHtml(item.game_name||"Untitled Game")}</div>
          <div class="list-item-sub muted">Open game page</div>
        </div>
      </div>
    `;
  }

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
        <div class="list-card-wrap" data-list-id="${l.id}">
          <button class="list-card list-open-btn" data-list-id="${l.id}" type="button" aria-label="Open ${escapeHtml(l.name)} list">
            <div class="list-covers">
              <img class="c1" src="${c1}" alt="">
              <img class="c2" src="${c2}" alt="">
              <img class="c3" src="${c3}" alt="">
            </div>
            <div class="list-name">${escapeHtml(l.name)}</div>
            <div class="list-count">${(l.items||[]).length} games</div>
            <div class="list-open-text">View games ↓</div>
          </button>
          <div class="list-inline-detail">
            ${
              (l.items||[]).length
                ? `<div class="list-detail-grid">${(l.items||[]).map(listItemCard).join("")}</div>`
                : `<div class="muted">No games in this list yet.</div>`
            }
          </div>
        </div>
      `;
    }).join("");

    grid.querySelectorAll(".list-open-btn").forEach(card=>{
      card.addEventListener("click",()=>{
        const wrap=card.closest(".list-card-wrap");
        if(!wrap) return;
        const isOpen=wrap.classList.contains("open");

        grid.querySelectorAll(".list-card-wrap.open").forEach(w=>{
          w.classList.remove("open");
          const openText=w.querySelector(".list-open-text");
          if(openText) openText.textContent="View games ↓";
        });

        if(!isOpen){
          wrap.classList.add("open");
          const openText=wrap.querySelector(".list-open-text");
          if(openText) openText.textContent="Hide games ↑";
        }
      });
    });
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
