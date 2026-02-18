import os
import re
import sqlite3
import requests

from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from werkzeug.security import generate_password_hash, check_password_hash

from db import init_db, connect

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "dev-secret-change-me")

CHEAPSHARK_BASE = "https://www.cheapshark.com/api/1.0"
STEAM_APPDETAILS = "https://store.steampowered.com/api/appdetails"


# ---------------- helpers ----------------
def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    conn = connect()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    conn.close()
    return user


def clean_username(u: str) -> str:
    u = (u or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_]{3,24}", u):
        return ""
    return u


def normalize_game(item):
    """
    Convert CheapShark items into RAWG-like objects:
    { id, name, background_image, rating, released, added, steam_appid }
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
            "rating": 0.0,
            "added": 0,
            "steam_appid": item.get("steamAppID"),
        }

    return {
        "id": str(item.get("gameID") or item.get("id") or "0"),
        "name": item.get("name") or item.get("title") or "Unknown",
        "background_image": item.get("background_image") or item.get("thumb") or "",
        "released": item.get("released"),
        "rating": float(item.get("rating") or 0.0),
        "added": int(item.get("added") or 0),
        "steam_appid": item.get("steam_appid") or item.get("steamAppID"),
    }


def get_steam_details(steam_appid):
    if not steam_appid:
        return None
    try:
        r = requests.get(STEAM_APPDETAILS, params={"appids": steam_appid}, timeout=12)
        data = r.json()
        block = data.get(str(steam_appid))
        if not block or not block.get("success"):
            return None
        return block.get("data")
    except Exception:
        return None


# ---------------- init ----------------
@app.before_request
def ensure_db():
    if not getattr(app, "_db_inited", False):
        init_db()
        app._db_inited = True


# ---------------- auth ----------------
@app.get("/")
def index():
    return redirect(url_for("home") if current_user() else url_for("login"))


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

    # auto-register (demo)
    if not user:
        pw_hash = generate_password_hash(password)
        conn.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, pw_hash))
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()

        # default list
        conn.execute("INSERT INTO lists (user_id, name) VALUES (?, ?)", (user["id"], "Play Later"))
        conn.commit()
    else:
        if not check_password_hash(user["password_hash"], password):
            conn.close()
            return render_template("login.html", error="Wrong username or password.")

    session["user_id"] = user["id"]
    conn.close()
    return redirect(url_for("home"))


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


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


# ---------------- GAME API (NO KEY) ----------------
@app.get("/api/trending")
def api_trending():
    try:
        r = requests.get(f"{CHEAPSHARK_BASE}/deals", params={"pageSize": 20, "sortBy": "Deal Rating"}, timeout=12)
        r.raise_for_status()
        results = [normalize_game(x) for x in r.json()]
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": "Failed to load trending", "detail": str(e)}), 500


@app.get("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"results": []})

    try:
        r = requests.get(f"{CHEAPSHARK_BASE}/games", params={"title": q, "limit": 20}, timeout=12)
        r.raise_for_status()
        results = [normalize_game(x) for x in r.json()]
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
    conn = connect()
    rows = conn.execute("""
        SELECT r.*, u.username
        FROM reviews r
        JOIN users u ON u.id = r.user_id
        WHERE r.game_id = ?
        ORDER BY r.created_at DESC
        LIMIT 20
    """, (str(game_id),)).fetchall()
    conn.close()
    return jsonify({"reviews": [dict(r) for r in rows]})


# ---------------- run ----------------
if __name__ == "__main__":
    app.run(debug=True)
