import os
import re
import requests
from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, session, jsonify, abort
from werkzeug.security import generate_password_hash, check_password_hash

from db import init_db, connect

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET", "dev-secret-change-me")

RAWG_API_KEY = os.getenv("RAWG_API_KEY", "")
RAWG_BASE = "https://api.rawg.io/api"

# ------------- helpers -------------
def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    conn = connect()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    conn.close()
    return user

def login_required():
    if not current_user():
        return redirect(url_for("login"))

def clean_username(u: str) -> str:
    u = (u or "").strip()
    # simple: letters/numbers/_ only
    if not re.fullmatch(r"[A-Za-z0-9_]{3,24}", u):
        return ""
    return u

def rawg_get(path, params=None):
    if not RAWG_API_KEY:
        return {"error": "Missing RAWG_API_KEY. Add it to your .env"}, 400

    params = params or {}
    params["key"] = RAWG_API_KEY
    r = requests.get(f"{RAWG_BASE}{path}", params=params, timeout=15)
    if r.status_code != 200:
        return {"error": f"RAWG error {r.status_code}", "detail": r.text[:300]}, r.status_code
    return r.json(), 200

# ------------- init -------------
@app.before_request
def ensure_db():
    if not getattr(app, "_db_inited", False):
        init_db()
        app._db_inited = True

# ------------- auth pages -------------
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

    # auto-register if user doesn't exist (simple for school projects)
    if not user:
        pw_hash = generate_password_hash(password)
        conn.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, pw_hash))
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()

        # create default list
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

# ------------- UI pages -------------
@app.get("/home")
def home():
    if not current_user():
        return redirect(url_for("login"))
    return render_template("home.html", user=current_user())

@app.get("/games")
def games():
    if not current_user():
        return redirect(url_for("login"))
    return render_template("games.html", user=current_user())

@app.get("/game/<int:game_id>")
def game_detail(game_id):
    if not current_user():
        return redirect(url_for("login"))
    return render_template("game_detail.html", user=current_user(), game_id=game_id)

@app.get("/review/<int:game_id>")
def review_page(game_id):
    if not current_user():
        return redirect(url_for("login"))
    return render_template("review.html", user=current_user(), game_id=game_id)

@app.get("/lists")
def lists_page():
    if not current_user():
        return redirect(url_for("login"))
    return render_template("lists.html", user=current_user())

@app.get("/profile")
def profile_page():
    if not current_user():
        return redirect(url_for("login"))
    return render_template("profile.html", user=current_user())

# ------------- API: games from RAWG -------------
@app.get("/api/trending")
def api_trending():
    # popular games this week-ish (RAWG: ordering=-added is a decent "trending" vibe)
    data, status = rawg_get("/games", params={"ordering": "-added", "page_size": 12})
    return jsonify(data), status

@app.get("/api/new_releases")
def api_new_releases():
    data, status = rawg_get("/games", params={"ordering": "-released", "page_size": 10})
    return jsonify(data), status

@app.get("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    page = request.args.get("page") or "1"
    data, status = rawg_get("/games", params={"search": q, "page": page, "page_size": 20})
    return jsonify(data), status

@app.get("/api/game/<int:game_id>")
def api_game(game_id):
    data, status = rawg_get(f"/games/{game_id}", params={})
    return jsonify(data), status

# ------------- API: lists / reviews in SQLite -------------
@app.get("/api/my/lists")
def api_my_lists():
    user = current_user()
    if not user:
        return jsonify({"error": "unauthorized"}), 401

    conn = connect()
    lists = conn.execute("SELECT * FROM lists WHERE user_id = ? ORDER BY created_at DESC", (user["id"],)).fetchall()
    out = []
    for l in lists:
        items = conn.execute("""
            SELECT * FROM list_items WHERE list_id = ? ORDER BY added_at DESC
        """, (l["id"],)).fetchall()
        out.append({"id": l["id"], "name": l["name"], "items": [dict(x) for x in items]})
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
    # verify list belongs to user
    owned = conn.execute("SELECT 1 FROM lists WHERE id = ? AND user_id = ?", (list_id, user["id"])).fetchone()
    if not owned:
        conn.close()
        return jsonify({"error": "forbidden"}), 403

    try:
        conn.execute("""
            INSERT INTO list_items (list_id, game_id, game_name, game_cover)
            VALUES (?, ?, ?, ?)
        """, (list_id, game_id, game_name, game_cover))
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    finally:
        conn.close()

    return jsonify({"ok": True})

@app.get("/api/reviews/<int:game_id>")
def api_reviews(game_id):
    conn = connect()
    rows = conn.execute("""
        SELECT r.*, u.username
        FROM reviews r
        JOIN users u ON u.id = r.user_id
        WHERE r.game_id = ?
        ORDER BY r.created_at DESC
        LIMIT 20
    """, (game_id,)).fetchall()
    conn.close()
    return jsonify({"reviews": [dict(r) for r in rows]})

@app.post("/api/reviews/<int:game_id>")
def api_post_review(game_id):
    user = current_user()
    if not user:
        return jsonify({"error": "unauthorized"}), 401

    rating = int(request.json.get("rating") or 0)
    body = (request.json.get("body") or "").strip()

    if rating < 1 or rating > 5 or len(body) < 3:
        return jsonify({"error": "rating 1-5 and review text required"}), 400

    conn = connect()
    conn.execute("""
        INSERT INTO reviews (user_id, game_id, rating, body)
        VALUES (?, ?, ?, ?)
    """, (user["id"], game_id, rating, body))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})

# ------------- run -------------
if __name__ == "__main__":
    app.run(debug=True)
