import sys
sys.path.insert(0, '.')
from core import database as _db
_db.reset_db()
from core.database import init_db
from core.retrieval import get_context_for_query
init_db()
print(get_context_for_query('episodic memory identity persona coherence agent believability virtual human', top_k=5))
