"""Unit tests for research-assistant claim-support retrieval, reranking, and quote extraction."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

RA_ROOT = Path(__file__).resolve().parents[2] / "research-assistant"
sys.path.insert(0, str(RA_ROOT))

from core import claim_support, database  # noqa: E402
from core.models import Chunk, Paper  # noqa: E402


class TestClaimSupport(unittest.TestCase):
    def test_clean_claim_text_strips_latex_and_pdf_artefacts(self) -> None:
        raw = "Trust in \\textbf{autonomous \\emph{systems}}~\\citep[p. 4]{lee2004} requires cali-\nbrated efﬁcacy. % comment"
        cleaned = claim_support.clean_claim_text(raw)
        self.assertEqual(cleaned, "Trust in autonomous systems requires calibrated efficacy.")

    def test_build_fts_or_query_sanitizes_punctuation_and_stopwords(self) -> None:
        q = database.build_fts_or_query("What is the role of self-attention: (Transformer) NOT/OR?")
        self.assertIn('"self"', q)
        self.assertIn('"attention"', q)
        self.assertIn('"transformer"', q)
        self.assertNotIn("(", q)
        self.assertNotIn(":", q)
        # Stopwords like "what", "is", "the", "of" are filtered
        self.assertNotIn('"the"', q)

    def test_split_sentences_respects_academic_abbreviations(self) -> None:
        text = (
            "As shown by Vaswani et al. (2017), attention replaces recurrence. "
            "See Fig. 2 for details on e.g. multi-head scaling. "
            "Empirical latency drops by 0.45 ms on average."
        )
        sents = claim_support.split_sentences(text)
        self.assertEqual(len(sents), 3)
        self.assertTrue(sents[0].startswith("As shown by Vaswani et al."))
        self.assertTrue(sents[1].startswith("See Fig. 2"))
        self.assertTrue(sents[2].startswith("Empirical latency"))

    def test_extract_best_quote_picks_supporting_sentence(self) -> None:
        chunk = (
            "We evaluated our method on three standard benchmarks in 2024. "
            "The Transformer is the first transduction model relying entirely on self-attention. "
            "Hyperparameters are listed in Appendix B."
        )
        quote, score = claim_support.extract_best_quote(
            "Transformers rely solely on self-attention mechanisms.",
            chunk,
        )
        self.assertIn("relying entirely on self-attention", quote)
        self.assertGreater(score, 0.2)

    def test_default_reranker_is_bge_reranker_base(self) -> None:
        from core.config import RetrievalConfig

        self.assertEqual(RetrievalConfig().reranker_model, "BAAI/bge-reranker-base")

    def test_score_with_cross_encoder_single_logit_and_nli(self) -> None:
        class FakeMsMarco:
            def __init__(self) -> None:
                self.seen_pairs: list[tuple[str, str]] = []

            def predict(self, pairs, show_progress_bar=False):
                self.seen_pairs = list(pairs)
                return [2.0, -2.0]

        ms = FakeMsMarco()
        scores = claim_support._score_with_cross_encoder(ms, [("claim1", "passage1"), ("claim2", "passage2")])
        self.assertEqual(ms.seen_pairs, [("claim1", "passage1"), ("claim2", "passage2")])
        self.assertGreater(scores[0], 0.85)
        self.assertLess(scores[1], 0.15)

        class FakeNli:
            model = SimpleNamespace(config=SimpleNamespace(id2label={0: "contradiction", 1: "entailment", 2: "neutral"}))

            def __init__(self) -> None:
                self.seen_pairs: list[tuple[str, str]] = []

            def predict(self, pairs, show_progress_bar=False):
                self.seen_pairs = list(pairs)
                return [[0.1, 4.0, 0.2], [4.0, 0.1, 0.2]]

        nli = FakeNli()
        nli_scores = claim_support._score_with_cross_encoder(nli, [("claim1", "passage1"), ("claim2", "passage2")])
        # NLI models must receive (premise=passage, hypothesis=claim)
        self.assertEqual(nli.seen_pairs, [("passage1", "claim1"), ("passage2", "claim2")])
        self.assertGreater(nli_scores[0], 0.9)
        self.assertLess(nli_scores[1], 0.1)

    def test_find_supporting_citations_end_to_end_fts_and_fake_reranker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old_env = os.environ.get("RA_DATA_DIR")
            os.environ["RA_DATA_DIR"] = tmp
            try:
                # Reset cached config/collections
                from core import config as cfg_mod
                cfg_mod._config = None
                database.reset_db()
                database.init_sqlite()

                p1 = Paper(
                    id="paper-transformer",
                    title="Attention Is All You Need",
                    authors=["Ashish Vaswani", "Noam Shazeer"],
                    year=2017,
                    file_path="/papers/vaswani2017.pdf",
                    file_hash="hash1",
                    added_at=datetime(2026, 1, 1),
                    tags=["@vaswani2017attention", "coll:NLP"],
                    page_count=15,
                    chunk_count=1,
                )
                p2 = Paper(
                    id="paper-trust",
                    title="Trust in Automation",
                    authors=["John D. Lee", "Katrina A. See"],
                    year=2004,
                    file_path="/papers/lee2004.pdf",
                    file_hash="hash2",
                    added_at=datetime(2026, 1, 1),
                    tags=["@lee2004trust", "coll:HRI"],
                    page_count=30,
                    chunk_count=1,
                )
                database.insert_paper(p1)
                database.insert_paper(p2)
                database.insert_chunks([
                    Chunk(
                        id="c1",
                        paper_id=p1.id,
                        content=(
                            "Recurrent neural networks have long dominated sequence modeling. "
                            "The Transformer is the first transduction model relying entirely on self-attention. "
                            "Training took 12 hours on eight GPUs."
                        ),
                        page_number=2,
                        chunk_index=0,
                    ),
                    Chunk(
                        id="c2",
                        paper_id=p2.id,
                        content=(
                            "Automation can fail unexpectedly in open environments. "
                            "Appropriate reliance depends on calibrating operator trust to system capability."
                        ),
                        page_number=5,
                        chunk_index=0,
                    ),
                ])

                class FakeReranker:
                    def predict(self, pairs, show_progress_bar=False):
                        return [3.5 if "self-attention" in passage.lower() else -2.0 for _, passage in pairs]

                with patch.object(claim_support, "get_provider", side_effect=RuntimeError("skip embeddings in unit test")), \
                     patch.object(claim_support, "chroma_query", return_value=[]), \
                     patch.object(claim_support, "_get_reranker", return_value=FakeReranker()):
                    res = claim_support.find_supporting_citations(
                        r"Modern models rely solely on \textbf{self-attention}~\cite{old}.",
                        top_k=5,
                        use_reranker=True,
                        reranker_model="fake-ce",
                    )

                self.assertEqual(res["reranker"], "fake-ce")
                self.assertGreaterEqual(len(res["results"]), 1)
                top = res["results"][0]
                self.assertEqual(top["citekey"], "vaswani2017attention")
                self.assertEqual(top["page"], 2)
                self.assertIn("relying entirely on self-attention", top["quote"])
                self.assertGreater(top["score"], 0.9)
            finally:
                if old_env is None:
                    os.environ.pop("RA_DATA_DIR", None)
                else:
                    os.environ["RA_DATA_DIR"] = old_env


if __name__ == "__main__":
    unittest.main()
