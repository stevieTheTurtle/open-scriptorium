"""Unit tests for agent-parametrizable search, pushdown filters, and chunk reading."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

RA_ROOT = Path(__file__).resolve().parents[2] / "research-assistant"
sys.path.insert(0, str(RA_ROOT))

from core import claim_support, config as cfg_mod, database, retrieval  # noqa: E402
from core.models import Chunk, Paper  # noqa: E402


class _TempDbTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old_env = os.environ.get("RA_DATA_DIR")
        os.environ["RA_DATA_DIR"] = self._tmp.name
        cfg_mod._config = None
        database.reset_db()
        database.init_sqlite()

        self.p_vaswani = Paper(
            id="11111111-aaaa-bbbb-cccc-000000000001",
            title="Attention Is All You Need",
            authors=["Ashish Vaswani", "Noam Shazeer"],
            year=2017,
            file_path="/papers/vaswani2017.pdf",
            file_hash="h1",
            added_at=datetime(2026, 1, 1),
            tags=["@vaswani2017attention", "coll:NLP/Transformers", "foundational"],
            page_count=15,
            chunk_count=2,
        )
        self.p_lee = Paper(
            id="22222222-aaaa-bbbb-cccc-000000000002",
            title="Trust in Automation: Designing for Appropriate Reliance",
            authors=["John D. Lee", "Katrina A. See"],
            year=2004,
            file_path="/papers/lee2004.pdf",
            file_hash="h2",
            added_at=datetime(2026, 1, 1),
            tags=["@lee2004trust", "coll:HRI/Trust", "survey"],
            page_count=30,
            chunk_count=2,
        )
        self.p_recent = Paper(
            id="33333333-aaaa-bbbb-cccc-000000000003",
            title="Calibrated Trust in LLM Agents",
            authors=["Alice Smith", "John D. Lee"],
            year=2025,
            file_path="/papers/smith2025.pdf",
            file_hash="h3",
            added_at=datetime(2026, 1, 1),
            tags=["@smith2025calibrated", "coll:HRI/Agents", "llm"],
            page_count=12,
            chunk_count=1,
        )

        for p in (self.p_vaswani, self.p_lee, self.p_recent):
            database.insert_paper(p)

        database.insert_chunks([
            Chunk(
                id="c_v1",
                paper_id=self.p_vaswani.id,
                content="The Transformer relies entirely on self-attention to compute representations.",
                page_number=2,
                chunk_index=0,
            ),
            Chunk(
                id="c_v2",
                paper_id=self.p_vaswani.id,
                content="Multi-head attention allows attending to information from different subspaces.",
                page_number=4,
                chunk_index=1,
            ),
            Chunk(
                id="c_l1",
                paper_id=self.p_lee.id,
                content="Trust calibration aligns operator trust with true automation capability.",
                page_number=5,
                chunk_index=0,
            ),
            Chunk(
                id="c_l2",
                paper_id=self.p_lee.id,
                content="Appropriate reliance avoids both misuse and disuse of automation.",
                page_number=12,
                chunk_index=1,
            ),
            Chunk(
                id="c_r1",
                paper_id=self.p_recent.id,
                content="Trust calibration trust calibration trust calibration in autonomous LLM agents.",
                page_number=3,
                chunk_index=0,
            ),
        ])

    def tearDown(self) -> None:
        database.reset_db()
        cfg_mod._config = None
        if self._old_env is None:
            os.environ.pop("RA_DATA_DIR", None)
        else:
            os.environ["RA_DATA_DIR"] = self._old_env
        self._tmp.cleanup()


class TestPushdownFiltersAndSearch(_TempDbTestCase):
    def test_resolve_paper_ref_by_id_prefix_and_citekey(self) -> None:
        self.assertEqual(database.resolve_paper_ref(self.p_lee.id).id, self.p_lee.id)
        self.assertEqual(database.resolve_paper_ref("22222222").id, self.p_lee.id)
        self.assertEqual(database.resolve_paper_ref("@lee2004trust").id, self.p_lee.id)
        self.assertEqual(database.resolve_paper_ref("LEE2004TRUST").id, self.p_lee.id)
        self.assertIsNone(database.resolve_paper_ref("nonexistent_key"))

    def test_resolve_filtered_paper_ids_combinations(self) -> None:
        # No filters -> None (unfiltered)
        self.assertIsNone(database.resolve_filtered_paper_ids())

        # Citekey filter (with and without @)
        self.assertEqual(
            database.resolve_filtered_paper_ids(citekeys=["@vaswani2017attention"]),
            [self.p_vaswani.id],
        )

        # Parent Zotero collection matches nested subcollections
        hri_ids = set(database.resolve_filtered_paper_ids(tags=["coll:HRI"]) or [])
        self.assertEqual(hri_ids, {self.p_lee.id, self.p_recent.id})

        # Author + year_from intersection
        recent_lee = database.resolve_filtered_paper_ids(author="john d. lee", year_from=2020)
        self.assertEqual(recent_lee, [self.p_recent.id])

        # Union of citekeys + ID prefix
        both = set(database.resolve_filtered_paper_ids(citekeys=["lee2004trust"], paper_ids=["11111111"]) or [])
        self.assertEqual(both, {self.p_lee.id, self.p_vaswani.id})

        # Non-matching filter returns empty list (not None)
        self.assertEqual(database.resolve_filtered_paper_ids(year=1999), [])

    def test_fts_pushdown_returns_filtered_paper_even_when_other_scores_higher(self) -> None:
        # Globally c_r1 repeats "trust calibration" 3x and wins top_k=1
        global_hits = database.fts_search("trust calibration", top_k=1)
        self.assertEqual(len(global_hits), 1)
        self.assertEqual(global_hits[0][0], "c_r1")

        # With pushdown to p_lee, top_k=1 directly returns c_l1 instead of starving!
        scoped_hits = database.fts_search("trust calibration", top_k=1, paper_ids=[self.p_lee.id])
        self.assertEqual(len(scoped_hits), 1)
        self.assertEqual(scoped_hits[0][0], "c_l1")

    def test_chroma_query_pushdown_builds_where_and_clamps_n_results(self) -> None:
        fake_col = MagicMock()
        fake_col.query.return_value = {"ids": [["c_l1"]], "distances": [[0.15]]}
        with patch.object(database, "_get_chroma", return_value=(None, fake_col)):
            hits = database.chroma_query([0.1, 0.2], top_k=50, paper_ids=[self.p_lee.id])

        self.assertEqual(hits, [("c_l1", 0.15)])
        _, kwargs = fake_col.query.call_args
        self.assertEqual(kwargs["where"], {"paper_id": self.p_lee.id})
        # p_lee only has 2 chunks -> n_results clamped from 50 to 2
        self.assertEqual(kwargs["n_results"], 2)

        # Multiple paper_ids -> $in filter
        with patch.object(database, "_get_chroma", return_value=(None, fake_col)):
            database.chroma_query([0.1, 0.2], top_k=50, paper_ids=[self.p_lee.id, self.p_recent.id])
        _, kwargs_multi = fake_col.query.call_args
        self.assertEqual(kwargs_multi["where"], {"paper_id": {"$in": [self.p_lee.id, self.p_recent.id]}})
        self.assertEqual(kwargs_multi["n_results"], 3)

    def test_retrieval_modes_weights_and_pushdown(self) -> None:
        # BM25-only mode never touches embedding provider or ChromaDB
        with patch.object(retrieval, "get_provider", side_effect=AssertionError("should not embed in bm25 mode")):
            res = retrieval.search("self-attention", top_k=5, mode="bm25", citekeys=["vaswani2017attention"])
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0].paper.id, self.p_vaswani.id)

        # Semantic-only mode never touches FTS5
        fake_provider = MagicMock()
        fake_provider.embed_query.return_value = [0.5, 0.5]
        with patch.object(retrieval, "get_provider", return_value=fake_provider), \
             patch.object(retrieval, "chroma_query", return_value=[("c_l2", 0.1)]) as mock_cq, \
             patch.object(retrieval, "fts_search", side_effect=AssertionError("should not call fts in semantic mode")):
            res_sem = retrieval.search("reliance", top_k=5, mode="semantic", year_to=2010)
        self.assertEqual(len(res_sem), 1)
        self.assertEqual(res_sem[0].paper.id, self.p_lee.id)
        self.assertAlmostEqual(res_sem[0].score, 0.9, places=5)
        self.assertEqual(mock_cq.call_args.kwargs["paper_ids"], [self.p_lee.id])

        # Hybrid weighted RRF: semantic_weight vs bm25_weight changes top paper
        with patch.object(retrieval, "get_provider", return_value=fake_provider), \
             patch.object(retrieval, "chroma_query", return_value=[("c_v1", 0.05), ("c_l1", 0.4)]), \
             patch.object(retrieval, "fts_search", return_value=[("c_l1", "text", 5.0), ("c_v1", "text", 1.0)]):
            res_sem_heavy = retrieval.search("q", top_k=2, semantic_weight=0.9, bm25_weight=0.1, rrf_k=10)
            res_bm25_heavy = retrieval.search("q", top_k=2, semantic_weight=0.1, bm25_weight=0.9, rrf_k=10)
        self.assertEqual(res_sem_heavy[0].paper.id, self.p_vaswani.id)
        self.assertEqual(res_bm25_heavy[0].paper.id, self.p_lee.id)

    def test_retrieval_opt_in_rerank(self) -> None:
        class FakeReranker:
            def predict(self, pairs, show_progress_bar=False):
                return [4.0 if "appropriate reliance" in p.lower() else -3.0 for _, p in pairs]

        with patch.object(claim_support, "_get_reranker", return_value=FakeReranker()):
            res = retrieval.search(
                "appropriate reliance on automation",
                top_k=5,
                mode="bm25",
                rerank=True,
                reranker_model="fake-ce",
            )
        self.assertGreaterEqual(len(res), 1)
        self.assertEqual(res[0].paper.id, self.p_lee.id)
        self.assertEqual(res[0].chunks[0].chunk_id, "c_l2")
        self.assertGreater(res[0].score, 0.95)

    def test_find_supporting_citations_pushdown_filters(self) -> None:
        class FakeReranker:
            def predict(self, pairs, show_progress_bar=False):
                return [3.0 for _ in pairs]

        with patch.object(claim_support, "get_provider", side_effect=RuntimeError("skip embeddings")), \
             patch.object(claim_support, "chroma_query", return_value=[]), \
             patch.object(claim_support, "_get_reranker", return_value=FakeReranker()):
            res = claim_support.find_supporting_citations(
                "Trust calibration aligns operator trust.",
                top_k=5,
                year_to=2010,
                tags=["coll:HRI"],
                reranker_model="fake-ce",
            )
        self.assertEqual(len(res["results"]), 1)
        self.assertEqual(res["results"][0]["citekey"], "lee2004trust")
        self.assertEqual(res["results"][0]["page"], 5)

    def test_get_chunks_for_paper_page_range(self) -> None:
        all_chunks = database.get_chunks_for_paper(self.p_lee.id)
        self.assertEqual(len(all_chunks), 2)
        p5_only = database.get_chunks_for_paper(self.p_lee.id, page_from=5, page_to=5)
        self.assertEqual([c.id for c in p5_only], ["c_l1"])
        p10_plus = database.get_chunks_for_paper(self.p_lee.id, page_from=10)
        self.assertEqual([c.id for c in p10_plus], ["c_l2"])


if __name__ == "__main__":
    unittest.main()
