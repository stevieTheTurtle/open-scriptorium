import sys, sqlite3
sys.path.insert(0, '.')
from core.database import get_sqlite_path, init_db
from core import database as _db
_db.reset_db()
init_db()
path = get_sqlite_path()
conn = sqlite3.connect(str(path))
rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print('Tables:', [r[0] for r in rows])
try:
    info = conn.execute("PRAGMA table_info(chunks_fts)").fetchall()
    print('FTS schema:', info)
    sample = conn.execute("SELECT * FROM chunks_fts LIMIT 2").fetchall()
    print('FTS sample:', sample)
except Exception as e:
    print('FTS error:', e)
conn.close()
