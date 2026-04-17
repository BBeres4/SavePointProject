import os
import re
import sqlite3
import requests
from datetime import datetime, timedelta

from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from werkzeug.security import generate_password_hash, check_password_hash

from db import init_db, connect

app = Flask(__name__) 
UPLOAD_FOLDER = "static/uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.secret_key = os.environ.get("FLASK_SECRET", "dev-secret-change-me")

CHEAPSHARK_BASE = "https://www.cheapshark.com/api/1.0"
STEAM_APPDETAILS = "https://store.steampowered.com/api/appdetails"
STEAM_DETAILS_CACHE = {}
BROWSE_GAMES_CACHE = {"expires_at": None, "results": []}


# ---------------- helpers ----------------
def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    conn = connect()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    conn.close()
    return user


def current_admin():
    aid = session.get("admin_id")
    if not aid:
        return None
    conn = connect()
    admin = conn.execute("SELECT * FROM admins WHERE id = ?", (aid,)).fetchone()
    conn.close()
    return admin


def normalize_theme(theme: str) -> str:
    return theme if theme in {"light", "dark"} else "light"


def clean_username(u: str) -> str:
    u = (u or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_]{3,24}", u):
        return ""
    return u


def is_following(conn, follower_id, following_id):
    row = conn.execute(
        "SELECT 1 FROM friendships WHERE follower_id = ? AND following_id = ?",
        (follower_id, following_id)
    ).fetchone()
    return bool(row)


def parse_release_year(raw_date):
    if not raw_date:
        return None

    if isinstance(raw_date, int):
        return raw_date if 1950 <= raw_date <= 2100 else None

    text = str(raw_date).strip()
    m = re.search(r"(19|20)\d{2}", text)
    if m:
        return int(m.group(0))

    for fmt in ("%b %d, %Y", "%d %b, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(text, fmt).year
        except ValueError:
            continue

    return None


def normalize_game(item):
    """
    Convert CheapShark items into RAWG-like objects:
    { id, name, background_image, rating, released, released_year, genres, added, steam_appid }
    """
    # Deals endpoint items
    if "dealID" in item and "title" in item:
        game_id = item.get("gameID") or item.get("dealID")
        name = item.get("title", "Unknown")
        img = item.get("thumb") or ""
        rating = float(item.get("dealRating") or 0.0)
        rating_5 = round(min(5.0, rating / 2.0), 1)
        return {
            "id": str(game_id),
            "name": name,
            "background_image": img,
            "released": None,
            "released_year": None,
            "genres": [],
            "rating": rating_5,
            "added": int(float(item.get("savings") or 0) * 10),
            "steam_appid": item.get("steamAppID"),
        }

    # Search endpoint items
    if "gameID" in item and ("external" in item or "thumb" in item):
        return {
            "id": str(item.get("gameID")),
            "name": item.get("external", "Unknown"),
            "background_image": item.get("thumb") or "",
            "released": None,
            "released_year": None,
            "genres": [],
            "rating": 0.0,
            "added": 0,
            "steam_appid": item.get("steamAppID"),
        }

    released = item.get("released")
    return {
        "id": str(item.get("gameID") or item.get("id") or "0"),
        "name": item.get("name") or item.get("title") or "Unknown",
        "background_image": item.get("background_image") or item.get("thumb") or "",
        "released": released,
        "released_year": parse_release_year(released),
        "genres": item.get("genres") or [],
        "rating": float(item.get("rating") or 0.0),
        "added": int(item.get("added") or 0),
        "steam_appid": item.get("steam_appid") or item.get("steamAppID"),
    }




def enrich_games_with_steam_metadata(games):
    for g in games:
        steam_appid = g.get("steam_appid")
        if not steam_appid:
            continue

        steam = get_steam_details(steam_appid)
        if not steam:
            continue

        release_text = steam.get("release_date", {}).get("date")
        release_year = parse_release_year(release_text)
        if release_text and not g.get("released"):
            g["released"] = release_text
        if release_year and not g.get("released_year"):
            g["released_year"] = release_year

        genres = steam.get("genres") or []
        if genres and not g.get("genres"):
            g["genres"] = [{"name": x.get("description")} for x in genres if x.get("description")]

    return games

def get_steam_details(steam_appid):
    if not steam_appid:
        return None
    cached = STEAM_DETAILS_CACHE.get(str(steam_appid))
    if cached is not None:
        return cached
    try:
        r = requests.get(STEAM_APPDETAILS, params={"appids": steam_appid}, timeout=12)
        data = r.json()
        block = data.get(str(steam_appid))
        if not block or not block.get("success"):
            STEAM_DETAILS_CACHE[str(steam_appid)] = None
            return None
        steam_data = block.get("data")
        STEAM_DETAILS_CACHE[str(steam_appid)] = steam_data
        return steam_data
    except Exception:
        return None


def load_browse_games():
    now = datetime.utcnow()
    expires_at = BROWSE_GAMES_CACHE.get("expires_at")
    if expires_at and expires_at > now and BROWSE_GAMES_CACHE.get("results"):
        return BROWSE_GAMES_CACHE["results"]

    collected = []
    seen_ids = set()

    # Use the deals endpoint for browsing; the games endpoint requires a search criterion.
    for page_number in range(3):
        r = requests.get(
            f"{CHEAPSHARK_BASE}/deals",
            params={"pageSize": 20, "pageNumber": page_number, "sortBy": "Deal Rating"},
            timeout=12
        )
        r.raise_for_status()

        page_items = [normalize_game(x) for x in r.json()]
        for game in page_items:
            game_id = game.get("id")
            if not game_id or game_id in seen_ids:
                continue
            seen_ids.add(game_id)
            collected.append(game)

    results = enrich_games_with_steam_metadata(collected)
    BROWSE_GAMES_CACHE["results"] = results
    BROWSE_GAMES_CACHE["expires_at"] = now + timedelta(minutes=30)
    return results


# ---------------- init ----------------
@app.before_request
def ensure_db():
    if not getattr(app, "_db_inited", False):
        init_db()
        app._db_inited = True


@app.context_processor
def inject_theme():
    user = current_user()
    if not user:
        return {"ui_theme": "light"}
    return {"ui_theme": normalize_theme(user["theme_preference"])}


# ---------------- auth ----------------
@app.get("/")
def index():
    if current_user():
        return redirect(url_for("home"))
    if current_admin():
        return redirect(url_for("admin_dashboard"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        if current_user():
            return redirect(url_for("home"))
        return render_template("login.html")

    username = clean_username(request.form.get("username"))
    password = request.form.get("password", "")

    if not username or len(password) < 6:
        return render_template("login.html", error="Enter a valid username and password (6+ chars).")

    conn = connect()
    user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        conn.close()
        return render_template("login.html", error="Wrong username or password.")

    session.clear()
    session["user_id"] = user["id"]
    conn.close()
    return redirect(url_for("home"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "GET":
        if current_user():
            return redirect(url_for("home"))
        return render_template("signup.html")

    username = clean_username(request.form.get("username"))
    password = request.form.get("password", "")
    confirm = request.form.get("confirm_password", "")

    if not username:
        return render_template("signup.html", error="Username must be 3-24 characters (letters, numbers, underscore).")

    if len(password) < 6:
        return render_template("signup.html", error="Password must be at least 6 characters.")

    if password != confirm:
        return render_template("signup.html", error="Passwords do not match.")

    conn = connect()
    existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        conn.close()
        return render_template("signup.html", error="Username is already taken.")

    pw_hash = generate_password_hash(password)
    conn.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, pw_hash))
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    conn.execute("INSERT INTO lists (user_id, name) VALUES (?, ?)", (user["id"], "Play Later"))
    conn.commit()
    conn.close()

    return redirect(url_for("login"))


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "GET":
        if current_admin():
            return redirect(url_for("admin_dashboard"))
        return render_template("admin_login.html")

    username = clean_username(request.form.get("username"))
    password = request.form.get("password", "")
    setup_code = (request.form.get("setup_code") or "").strip()

    if not username or len(password) < 6:
        return render_template("admin_login.html", error="Enter a valid admin username and password.")

    conn = connect()
    admin = conn.execute("SELECT * FROM admins WHERE username = ?", (username,)).fetchone()

    # First admin bootstrap flow: requires ADMIN_SETUP_CODE if provided.
    if not admin:
        expected_setup_code = os.environ.get("ADMIN_SETUP_CODE", "").strip()
        if expected_setup_code and setup_code != expected_setup_code:
            conn.close()
            return render_template("admin_login.html", error="Admin not found. Invalid setup code for admin creation.")
        pw_hash = generate_password_hash(password)
        conn.execute(
            "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
            (username, pw_hash)
        )
        conn.commit()
        admin = conn.execute("SELECT * FROM admins WHERE username = ?", (username,)).fetchone()
    elif not check_password_hash(admin["password_hash"], password):
        conn.close()
        return render_template("admin_login.html", error="Wrong admin username or password.")

    session.clear()
    session["admin_id"] = admin["id"]
    conn.close()
    return redirect(url_for("admin_dashboard"))


@app.get("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))


@app.route("/admin", methods=["GET", "POST"])
def admin_dashboard():
    admin = current_admin()
    if not admin:
        return redirect(url_for("admin_login"))

    conn = connect()
    error = None
    notice = None
    if request.method == "POST":
        title = (request.form.get("title") or "").strip()
        genre = (request.form.get("genre") or "").strip()
        platform = (request.form.get("platform") or "").strip()
        release_year_raw = (request.form.get("release_year") or "").strip()
        release_year = parse_release_year(release_year_raw) if release_year_raw else None

        if len(title) < 2:
            error = "Game title must be at least 2 characters."
        else:
            conn.execute("""
                INSERT INTO managed_games (title, genre, platform, release_year, added_by_admin_id)
                VALUES (?, ?, ?, ?, ?)
            """, (title, genre or None, platform or None, release_year, admin["id"]))
            conn.commit()
            notice = f"Added game '{title}' to admin-managed catalog."

    user_count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    reviews_count = conn.execute("SELECT COUNT(*) AS c FROM reviews").fetchone()["c"]
    lists_count = conn.execute("SELECT COUNT(*) AS c FROM lists").fetchone()["c"]
    managed_games_count = conn.execute("SELECT COUNT(*) AS c FROM managed_games").fetchone()["c"]

    q = (request.args.get("q") or "").strip()
    users = []
    if q:
        users = conn.execute("""
            SELECT id, username, created_at
            FROM users
            WHERE username LIKE ?
            ORDER BY username ASC
            LIMIT 25
        """, (f"%{q}%",)).fetchall()

    selected_user_id = request.args.get("user_id")
    selected_user = None
    activity = []
    if selected_user_id and str(selected_user_id).isdigit():
        selected_user = conn.execute(
            "SELECT id, username, created_at FROM users WHERE id = ?",
            (int(selected_user_id),)
        ).fetchone()
        if selected_user:
            activity = conn.execute("""
                SELECT 'review' AS type, r.created_at AS at, r.game_id AS game_ref,
                       ('Rated ' || r.rating || '/5 - ' || substr(r.body, 1, 80)) AS detail
                FROM reviews r
                WHERE r.user_id = ?

                UNION ALL

                SELECT 'list_add' AS type, li.added_at AS at, li.game_id AS game_ref,
                       ('Added to list: ' || li.game_name) AS detail
                FROM list_items li
                JOIN lists l ON l.id = li.list_id
                WHERE l.user_id = ?

                UNION ALL

                SELECT 'follow' AS type, f.created_at AS at, NULL AS game_ref,
                       ('Followed user #' || f.following_id) AS detail
                FROM friendships f
                WHERE f.follower_id = ?

                ORDER BY at DESC
                LIMIT 50
            """, (selected_user["id"], selected_user["id"], selected_user["id"])).fetchall()

    managed_games = conn.execute("""
        SELECT mg.*, a.username AS admin_username
        FROM managed_games mg
        JOIN admins a ON a.id = mg.added_by_admin_id
        ORDER BY mg.created_at DESC
        LIMIT 40
    """).fetchall()

    conn.close()
    return render_template(
        "admin_dashboard.html",
        admin=admin,
        error=error,
        notice=notice,
        metrics={
            "user_count": user_count,
            "reviews_count": reviews_count,
            "lists_count": lists_count,
            "managed_games_count": managed_games_count,
        },
        q=q,
        users=users,
        selected_user=selected_user,
        activity=activity,
        managed_games=managed_games,
    )


# ---------------- pages ----------------
@app.get("/home")
def home():
    user = current_user()
    if not user:
        return redirect(url_for("login"))
    return render_template("home.html", user=user)


@app.get("/games")
def games():
    user = current_user()
    if not user:
        return redirect(url_for("login"))
    return render_template("games.html", user=user)


@app.get("/game/<game_id>")
def game_detail(game_id):
    user = current_user()
    if not user:
        return redirect(url_for("login"))
    return render_template("game_detail.html", user=user, game_id=game_id)


# ✅ FIXED: Review page now supports POST
@app.route("/review/<game_id>", methods=["GET", "POST"])
def review_page(game_id):
    user = current_user()
    if not user:
        return redirect(url_for("login"))

    if request.method == "POST":
        rating = int(request.form.get("rating", 0))
        body = (request.form.get("body") or "").strip()

        if rating < 1 or rating > 5:
            return render_template("review.html", user=user, game_id=game_id, error="Please choose a star rating (1–5).")

        if len(body) < 3:
            return render_template("review.html", user=user, game_id=game_id, error="Please write a review (at least 3 characters).")

        conn = connect()
        conn.execute("""
            INSERT INTO reviews (user_id, game_id, rating, body)
            VALUES (?, ?, ?, ?)
        """, (user["id"], str(game_id), rating, body))
        conn.commit()
        conn.close()

        return redirect(url_for("game_detail", game_id=game_id))

    return render_template("review.html", user=user, game_id=game_id)


@app.get("/lists")
def lists_page():
    user = current_user()
    if not user:
        return redirect(url_for("login"))
    return render_template("lists.html", user=user)


@app.get("/profile")
def profile_page():
    user = current_user()
    if not user:
        return redirect(url_for("login"))
    return render_template("profile.html", user=user)

@app.get("/api/profile/stats")
def api_profile_stats():
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()
    followers = conn.execute(
        "SELECT COUNT(*) AS c FROM friendships WHERE following_id = ?",
        (me["id"],)
    ).fetchone()["c"]
    following = conn.execute(
        "SELECT COUNT(*) AS c FROM friendships WHERE follower_id = ?",
        (me["id"],)
    ).fetchone()["c"]
    lists_count = conn.execute(
        "SELECT COUNT(*) AS c FROM lists WHERE user_id = ?",
        (me["id"],)
    ).fetchone()["c"]
    reviews_count = conn.execute(
        "SELECT COUNT(*) AS c FROM reviews WHERE user_id = ?",
        (me["id"],)
    ).fetchone()["c"]
    total_games = conn.execute("""
        SELECT COUNT(DISTINCT game_id) AS c
        FROM (
            SELECT li.game_id AS game_id
            FROM list_items li
            JOIN lists l ON l.id = li.list_id
            WHERE l.user_id = ?
            UNION
            SELECT r.game_id AS game_id
            FROM reviews r
            WHERE r.user_id = ?
        )
    """, (me["id"], me["id"])).fetchone()["c"]
    conn.close()

    return jsonify({
        "followers": followers,
        "following": following,
        "lists": lists_count,
        "reviews": reviews_count,
        "total_games": total_games,
    })


@app.get("/api/profile/content")
def api_profile_content():
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()

    favorite_rows = conn.execute("""
        SELECT li.game_id, li.game_name, li.game_cover, MAX(li.added_at) AS last_seen
        FROM list_items li
        JOIN lists l ON l.id = li.list_id
        WHERE l.user_id = ? AND lower(l.name) LIKE '%favorite%'
        GROUP BY li.game_id, li.game_name, li.game_cover
        ORDER BY last_seen DESC
        LIMIT 8
    """, (me["id"],)).fetchall()

    recently_played_rows = conn.execute("""
        SELECT li.game_id, li.game_name, li.game_cover, MAX(li.added_at) AS last_seen
        FROM list_items li
        JOIN lists l ON l.id = li.list_id
        WHERE l.user_id = ? AND (lower(l.name) LIKE '%played%' OR lower(l.name) LIKE '%recent%')
        GROUP BY li.game_id, li.game_name, li.game_cover
        ORDER BY last_seen DESC
        LIMIT 8
    """, (me["id"],)).fetchall()

    reviewed_rows = conn.execute("""
        SELECT r.id, r.game_id, r.rating, r.body, r.created_at, u.username,
               COALESCE(li.game_name, ('Game #' || r.game_id)) AS game_name,
               COALESCE(li.game_cover, '') AS game_cover
        FROM reviews r
        JOIN users u ON u.id = r.user_id
        LEFT JOIN (
            SELECT li1.game_id, li1.game_name, li1.game_cover, l1.user_id, MAX(li1.added_at) AS max_added_at
            FROM list_items li1
            JOIN lists l1 ON l1.id = li1.list_id
            GROUP BY li1.game_id, l1.user_id
        ) li ON li.game_id = r.game_id AND li.user_id = r.user_id
        WHERE r.user_id = ?
        ORDER BY r.created_at DESC
        LIMIT 8
    """, (me["id"],)).fetchall()
    conn.close()

    def as_game(row):
        return {
            "id": str(row["game_id"]),
            "name": row["game_name"] or f"Game #{row['game_id']}",
            "background_image": row["game_cover"] or "",
            "released": None,
            "rating": 0.0,
            "added": 0,
        }

    favorites = [as_game(r) for r in favorite_rows]
    recently_played = [as_game(r) for r in recently_played_rows]

    if not favorites:
        favorites = [as_game(r) for r in reviewed_rows[:4]]
    if not recently_played:
        recently_played = [as_game(r) for r in reviewed_rows[4:8] or reviewed_rows[:4]]

    reviewed = [dict(r) for r in reviewed_rows]
    return jsonify({
        "favorites": favorites,
        "recently_played": recently_played,
        "recently_reviewed": reviewed,
    })

@app.route("/settings", methods=["GET", "POST"])
def settings_page():
    user = current_user()
    if not user:
        return redirect(url_for("login"))

    if request.method == "POST":
        username = clean_username(request.form.get("username"))
        password = request.form.get("password")
        theme_preference = normalize_theme(request.form.get("theme_preference", "light"))

        file = request.files.get("profile_pic")
        remove_pic = request.form.get("remove_pic") == "on"

        if not username:
            return render_template("settings.html", user=user, error="Invalid username")

        conn = connect()

        # update username
        conn.execute(
            "UPDATE users SET username = ? WHERE id = ?",
            (username, user["id"])
        )

        # update theme
        conn.execute(
            "UPDATE users SET theme_preference = ? WHERE id = ?",
            (theme_preference, user["id"])
        )

        # update password
        if password and len(password) >= 6:
            pw_hash = generate_password_hash(password)
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (pw_hash, user["id"])
            )

        # REMOVE profile pic (emoji fallback)
        if remove_pic:
            conn.execute(
                "UPDATE users SET profile_pic = NULL WHERE id = ?",
                (user["id"],)
            )

        # UPLOAD new profile pic
        elif file and file.filename.lower().endswith((".png", ".jpg", ".jpeg", ".gif")):
            from werkzeug.utils import secure_filename
            import uuid

            filename = str(uuid.uuid4()) + "_" + secure_filename(file.filename)
            filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)

            file.save(filepath) 
       
            conn.execute(
                "UPDATE users SET profile_pic = ? WHERE id = ?",
                (f"/static/uploads/{filename}", user["id"])
            )

        conn.commit()
        conn.close()

        return redirect(url_for("profile_page"))

    return render_template("settings.html", user=user)
# ---------------- GAME API (NO KEY) ----------------
@app.get("/api/trending")
def api_trending():
    try:
        r = requests.get(f"{CHEAPSHARK_BASE}/deals", params={"pageSize": 20, "sortBy": "Deal Rating"}, timeout=12)
        r.raise_for_status()
        results = [normalize_game(x) for x in r.json()]
        results = enrich_games_with_steam_metadata(results)
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": "Failed to load trending", "detail": str(e)}), 500


@app.get("/api/browse")
def api_browse():
    try:
        results = load_browse_games()
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": "Failed to load games", "detail": str(e)}), 500


@app.get("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"results": []})

    try:
        r = requests.get(f"{CHEAPSHARK_BASE}/games", params={"title": q, "limit": 20}, timeout=12)
        r.raise_for_status()
        results = [normalize_game(x) for x in r.json()]
        results = enrich_games_with_steam_metadata(results)
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": "Search failed", "detail": str(e)}), 500


@app.get("/api/game/<game_id>")
def api_game(game_id):
    try:
        r = requests.get(f"{CHEAPSHARK_BASE}/games", params={"id": game_id}, timeout=12)
        r.raise_for_status()
        data = r.json()

        info = data.get("info", {})
        steam_appid = info.get("steamAppID")

        base = {
            "id": str(game_id),
            "name": info.get("title", "Unknown"),
            "background_image": info.get("thumb") or "",
            "released": None,
            "rating": 0.0,
            "added": 1200,
            "developers": [{"name": "Unknown Studio"}],
            "description_raw": "No description available.",
        }

        steam = get_steam_details(steam_appid)
        if steam:
            header = steam.get("header_image")
            if header:
                base["background_image"] = header

            desc = steam.get("short_description") or steam.get("about_the_game")
            if desc:
                base["description_raw"] = re.sub(r"<[^>]*>", "", desc).strip()

            devs = steam.get("developers") or []
            if devs:
                base["developers"] = [{"name": devs[0]}]

            mc = steam.get("metacritic", {}).get("score")
            if mc:
                base["rating"] = round(min(5.0, mc / 20.0), 1)

            rd = steam.get("release_date", {}).get("date")
            if rd:
                base["released"] = rd

        return jsonify(base)

    except Exception as e:
        return jsonify({"error": "Game detail failed", "detail": str(e)}), 500


# ---------------- LISTS / REVIEWS (SQLite) ----------------
@app.get("/api/my/lists")
def api_my_lists():
    user = current_user()
    if not user:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()
    lists = conn.execute(
        "SELECT * FROM lists WHERE user_id = ? ORDER BY created_at DESC",
        (user["id"],)
    ).fetchall()

    out = []
    for l in lists:
        items = conn.execute(
            "SELECT * FROM list_items WHERE list_id = ? ORDER BY added_at DESC",
            (l["id"],)
        ).fetchall()

        out.append({
            "id": l["id"],
            "name": l["name"],
            "items": [dict(x) for x in items]
        })

    conn.close()
    return jsonify({"lists": out})


@app.post("/api/my/lists")
def api_create_list():
    user = current_user()
    if not user:
        return jsonify({"error": "unauthorized"}), 401

    name = (request.json.get("name") or "").strip()
    if not name:
        return jsonify({"error": "missing list name"}), 400

    conn = connect()
    conn.execute("INSERT INTO lists (user_id, name) VALUES (?, ?)", (user["id"], name))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/api/my/lists/add")
def api_add_to_list():
    user = current_user()
    if not user:
        return jsonify({"error": "unauthorized"}), 401

    list_id = request.json.get("list_id")
    game_id = request.json.get("game_id")
    game_name = request.json.get("game_name")
    game_cover = request.json.get("game_cover")

    if not list_id or not game_id or not game_name:
        return jsonify({"error": "missing fields"}), 400

    conn = connect()
    owned = conn.execute(
        "SELECT 1 FROM lists WHERE id = ? AND user_id = ?",
        (list_id, user["id"])
    ).fetchone()
    if not owned:
        conn.close()
        return jsonify({"error": "forbidden"}), 403

    try:
        conn.execute("""
            INSERT INTO list_items (list_id, game_id, game_name, game_cover)
            VALUES (?, ?, ?, ?)
        """, (list_id, str(game_id), game_name, game_cover))
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    finally:
        conn.close()

    return jsonify({"ok": True})


@app.get("/api/reviews/<game_id>")
def api_reviews(game_id):
    me = current_user()
    conn = connect()
    rows = conn.execute("""
        SELECT r.*, u.username
        FROM reviews r
        JOIN users u ON u.id = r.user_id
        WHERE r.game_id = ?
        ORDER BY r.created_at DESC
        LIMIT 20
    """, (str(game_id),)).fetchall()
    out = []
    for r in rows:
        review_id = r["id"]
        likes_count = conn.execute(
            "SELECT COUNT(*) AS c FROM review_likes WHERE review_id = ?",
            (review_id,)
        ).fetchone()["c"]
        comments_count = conn.execute(
            "SELECT COUNT(*) AS c FROM review_comments WHERE review_id = ?",
            (review_id,)
        ).fetchone()["c"]
        liked_by_me = False
        if me:
            liked_by_me = bool(conn.execute(
                "SELECT 1 FROM review_likes WHERE review_id = ? AND user_id = ?",
                (review_id, me["id"])
            ).fetchone())

        payload = dict(r)
        payload["likes_count"] = likes_count
        payload["comments_count"] = comments_count
        payload["liked_by_me"] = liked_by_me
        out.append(payload)

    conn.close()
    return jsonify({"reviews": out})


@app.get("/api/friends")
def api_friends():
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()
    rows = conn.execute("""
        SELECT u.id, u.username
        FROM friendships f
        JOIN users u ON u.id = f.following_id
        WHERE f.follower_id = ?
        ORDER BY f.created_at DESC
    """, (me["id"],)).fetchall()
    conn.close()
    return jsonify({"friends": [dict(r) for r in rows]})


@app.get("/api/friends/search")
def api_friends_search():
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"results": []})

    conn = connect()
    rows = conn.execute("""
        SELECT id, username
        FROM users
        WHERE username LIKE ? AND id != ?
        ORDER BY username ASC
        LIMIT 10
    """, (f"%{q}%", me["id"])).fetchall()

    out = []
    for r in rows:
        x = dict(r)
        x["following"] = is_following(conn, me["id"], r["id"])
        out.append(x)
    conn.close()
    return jsonify({"results": out})


@app.post("/api/friends/follow")
def api_friends_follow():
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    following_id = request.json.get("friend_id")
    if not following_id:
        return jsonify({"error": "missing friend_id"}), 400
    if int(following_id) == int(me["id"]):
        return jsonify({"error": "cannot follow yourself"}), 400

    conn = connect()
    try:
        conn.execute(
            "INSERT INTO friendships (follower_id, following_id) VALUES (?, ?)",
            (me["id"], int(following_id))
        )
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.post("/api/friends/unfollow")
def api_friends_unfollow():
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    following_id = request.json.get("friend_id")
    if not following_id:
        return jsonify({"error": "missing friend_id"}), 400

    conn = connect()
    conn.execute(
        "DELETE FROM friendships WHERE follower_id = ? AND following_id = ?",
        (me["id"], int(following_id))
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/activity/feed")
def api_activity_feed():
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()
    rows = conn.execute("""
        SELECT 'review' AS type, r.created_at AS at, r.id AS ref_id,
               r.game_id, r.rating, r.body, u.username, u.id AS user_id
        FROM reviews r
        JOIN friendships f ON f.following_id = r.user_id
        JOIN users u ON u.id = r.user_id
        WHERE f.follower_id = ?

        UNION ALL

        SELECT 'play_later_add' AS type, li.added_at AS at, li.id AS ref_id,
               li.game_id, NULL AS rating, li.game_name AS body, u.username, u.id AS user_id
        FROM list_items li
        JOIN lists l ON l.id = li.list_id
        JOIN friendships f ON f.following_id = l.user_id
        JOIN users u ON u.id = l.user_id
        WHERE f.follower_id = ? AND lower(l.name) = 'play later'

        ORDER BY at DESC
        LIMIT 30
    """, (me["id"], me["id"])).fetchall()
    conn.close()
    return jsonify({"activities": [dict(r) for r in rows]})


@app.post("/api/review/<int:review_id>/like")
def api_review_like(review_id):
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()
    existing = conn.execute(
        "SELECT id FROM review_likes WHERE review_id = ? AND user_id = ?",
        (review_id, me["id"])
    ).fetchone()
    if existing:
        conn.execute("DELETE FROM review_likes WHERE id = ?", (existing["id"],))
        liked = False
    else:
        conn.execute(
            "INSERT INTO review_likes (review_id, user_id) VALUES (?, ?)",
            (review_id, me["id"])
        )
        liked = True
    conn.commit()
    likes_count = conn.execute(
        "SELECT COUNT(*) AS c FROM review_likes WHERE review_id = ?",
        (review_id,)
    ).fetchone()["c"]
    conn.close()
    return jsonify({"ok": True, "liked": liked, "likes_count": likes_count})


@app.get("/api/review/<int:review_id>/comments")
def api_review_comments(review_id):
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()
    rows = conn.execute("""
        SELECT rc.id, rc.body, rc.created_at, u.username
        FROM review_comments rc
        JOIN users u ON u.id = rc.user_id
        WHERE rc.review_id = ?
        ORDER BY rc.created_at ASC
    """, (review_id,)).fetchall()
    conn.close()
    return jsonify({"comments": [dict(r) for r in rows]})


@app.post("/api/review/<int:review_id>/comments")
def api_review_comment_add(review_id):
    me = current_user()
    if not me:
        return jsonify({"error": "unauthorized"}), 401

    body = (request.json.get("body") or "").strip()
    if len(body) < 1:
        return jsonify({"error": "comment required"}), 400

    conn = connect()
    conn.execute(
        "INSERT INTO review_comments (review_id, user_id, body) VALUES (?, ?, ?)",
        (review_id, me["id"], body)
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------------- run ----------------
if __name__ == "__main__":
    app.run(debug=True)
