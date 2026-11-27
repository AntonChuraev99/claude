"""Unit tests for the pricing logic of gemini.py (no network)."""
import datetime as dt
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import gemini  # noqa: E402

PRICES = {
    "models": {
        "m-flash": {"input": 1.0, "output": 4.0},
        "m-flash-lite": {"input": 0.5, "output": 2.0},
        "m-image": {"input": 1.0, "output": 3.0, "image_output": 60.0},
        "m-pro": {"input": 2.0, "output": 12.0, "long_context_threshold": 200000,
                  "long_context": {"input": 4.0, "output": 18.0}},
        "m-dated": {"input": 1.0, "output": 5.0, "changes": {"2026-12-01": {"input": 2.0, "output": 10.0}}},
    }
}


class FakeDate(dt.date):
    today_value = dt.date(2026, 11, 27)

    @classmethod
    def today(cls):
        return cls.today_value


class PriceForTest(unittest.TestCase):
    def test_exact_id(self):
        self.assertEqual(gemini.price_for(PRICES, "m-flash")[0], "m-flash")

    def test_longest_exact_wins_over_prefix(self):
        self.assertEqual(gemini.price_for(PRICES, "m-flash-lite")[0], "m-flash-lite")

    def test_version_suffix_uses_base_price(self):
        self.assertEqual(gemini.price_for(PRICES, "m-flash-preview")[0], "m-flash")
        self.assertEqual(gemini.price_for(PRICES, "m-flash-lite-preview")[0], "m-flash-lite")
        self.assertEqual(gemini.price_for(PRICES, "m-flash-001")[0], "m-flash")

    def test_other_product_suffix_is_unpriced(self):
        self.assertEqual(gemini.price_for(PRICES, "m-flash-preview-tts"), (None, None))
        self.assertEqual(gemini.price_for(PRICES, "m-flash-tts"), (None, None))
        self.assertEqual(gemini.price_for(PRICES, "unknown-model"), (None, None))

    def test_price_change_before_and_after_date(self):
        with mock.patch.object(gemini.dt, "date", FakeDate):
            FakeDate.today_value = dt.date(2026, 11, 30)
            self.assertEqual(gemini.price_for(PRICES, "m-dated")[1]["input"], 1.0)
            FakeDate.today_value = dt.date(2026, 12, 1)
            rate = gemini.price_for(PRICES, "m-dated")[1]
            self.assertEqual((rate["input"], rate["output"]), (2.0, 10.0))
            self.assertNotIn("changes", rate)

    def test_price_for_does_not_mutate_table(self):
        with mock.patch.object(gemini.dt, "date", FakeDate):
            FakeDate.today_value = dt.date(2027, 1, 1)
            gemini.price_for(PRICES, "m-dated")
        self.assertIn("changes", PRICES["models"]["m-dated"])
        self.assertEqual(PRICES["models"]["m-dated"]["input"], 1.0)


class CostOfTest(unittest.TestCase):
    def test_text_with_thinking(self):
        usage = {"promptTokenCount": 1_000_000, "candidatesTokenCount": 500_000, "thoughtsTokenCount": 500_000}
        usd, tokens = gemini.cost_of(usage, PRICES["models"]["m-flash"])
        self.assertAlmostEqual(usd, 1.0 + 4.0)
        self.assertEqual(tokens, {"prompt": 1_000_000, "text_out": 1_000_000, "image_out": 0})

    def test_image_tokens_use_image_rate(self):
        usage = {"promptTokenCount": 0, "candidatesTokenCount": 1_000_100,
                 "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 1_000_000},
                                             {"modality": "TEXT", "tokenCount": 100}]}
        usd, tokens = gemini.cost_of(usage, PRICES["models"]["m-image"])
        self.assertAlmostEqual(usd, 60.0 + 100 * 3.0 / 1_000_000)
        self.assertEqual(tokens["image_out"], 1_000_000)
        self.assertEqual(tokens["text_out"], 100)

    def test_long_context_tier(self):
        rate = PRICES["models"]["m-pro"]
        short, _ = gemini.cost_of({"promptTokenCount": 200_000, "candidatesTokenCount": 0}, rate)
        long_, _ = gemini.cost_of({"promptTokenCount": 200_001, "candidatesTokenCount": 0}, rate)
        self.assertAlmostEqual(short, 200_000 * 2.0 / 1_000_000)
        self.assertAlmostEqual(long_, 200_001 * 4.0 / 1_000_000)

    def test_missing_usage_is_zero(self):
        self.assertEqual(gemini.cost_of({}, PRICES["models"]["m-flash"])[0], 0.0)


class SplitTokensTest(unittest.TestCase):
    def test_image_tokens_split_without_price(self):
        usage = {"promptTokenCount": 10, "candidatesTokenCount": 1130, "thoughtsTokenCount": 5,
                 "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 1120}]}
        self.assertEqual(gemini.split_tokens(usage), {"prompt": 10, "text_out": 15, "image_out": 1120})


class TodayTotalTest(unittest.TestCase):
    def test_broken_line_does_not_drop_later_rows(self):
        import tempfile
        today = dt.date.today().isoformat()
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "spend.jsonl"
            log.write_text("\n".join([
                f'{{"ts": "{today}T10:00:00", "usd": 0.5}}',
                "not json",
                "[1, 2]",
                f'{{"ts": "{today}T11:00:00", "usd": 0.25}}',
                f'{{"ts": "{today}T12:00:00", "usd": null}}',
                '{"ts": "2000-01-01T00:00:00", "usd": 9.0}',
            ]), encoding="utf-8")
            with mock.patch.object(gemini, "SPEND_LOG", log):
                total, unknown = gemini.today_total()
        self.assertAlmostEqual(total, 0.75)
        self.assertEqual(unknown, 1)


class PricesFileTest(unittest.TestCase):
    def test_shipped_prices_are_valid(self):
        prices = gemini.load_prices()
        for mid, rate in prices["models"].items():
            with self.subTest(model=mid):
                self.assertGreater(rate["input"], 0)
                self.assertGreater(rate["output"], 0)
                for when in rate.get("changes", {}):
                    dt.date.fromisoformat(when)


if __name__ == "__main__":
    unittest.main()
