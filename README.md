## IMPORTANT
We now have a working login/create account system. Please do not sign in or create an account. Please login with this info:

User: bberes4

Password: vyLnJC@Gv9

# SavePointProject


how to run 
1) install git
2) go to "terminal"
3) ONE TIME THING type "git clone https://github.com/YOUR_USERNAME/SavePointProject.git"
4) type in terminal - cd SavePointProject
5) type in terminal - python -m venv venv
6) type in terminal - venv\Scripts\activate
7) type in terminal - pip install -r requirements.txt
8) type in terminal - git pull
9) type in terminal - python app.py
10) click the "running on 4713.1289.199" type link


ignore all this for now:
python -c "import sqlite3; conn=sqlite3.connect('app.sqlite'); cur=conn.cursor(); [print(r) for r in cur.execute('SELECT id, username, created_at FROM users ORDER BY id')]; conn.close()"

python -c "import sqlite3; conn=sqlite3.connect('app.sqlite'); cur=conn.cursor(); [print(r) for r in cur.execute('SELECT id, username, password_hash, created_at FROM users ORDER BY id')]; conn.close()"
