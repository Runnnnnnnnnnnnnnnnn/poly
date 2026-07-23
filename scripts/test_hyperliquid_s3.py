#!/usr/bin/env python3
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import lz4.frame
import pyarrow.parquet as pq


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary)
        raw = target / "raw/20260701/9/l2Book/BTC.lz4"
        raw.parent.mkdir(parents=True)
        messages = [
            {
                "channel": "l2Book",
                "data": {
                    "coin": "BTC",
                    "time": 1782896400000 + offset,
                    "levels": [
                        [{"px": "100.0", "sz": "2"}, {"px": "99.9", "sz": "1"}],
                        [{"px": "100.1", "sz": "3"}, {"px": "100.2", "sz": "1"}],
                    ],
                },
            }
            for offset in (0, 5000)
        ]
        with lz4.frame.open(raw, mode="wt", encoding="utf-8") as output:
            for message in messages:
                output.write(json.dumps(message) + "\n")
        result = json.loads(subprocess.check_output([
            sys.executable,
            str(root / "scripts/audit-hyperliquid-s3.py"),
            "--date", "20260701",
            "--assets", "BTC",
            "--hours", "9",
            "--root", str(target),
        ], text=True))
        assert result["status"] == "healthy", result
        assert result["acceptedRows"] == 2
        parquet = target / "verified/date=20260701/hour=09/BTC.parquet"
        assert pq.ParquetFile(parquet).metadata.num_rows == 2
        assert result["objects"][0]["duplicateRows"] == 0
        module = load_backtest_module(root)
        rows, supplement = module.load_historical_l2(target)
        assert supplement["status"] == "audited", supplement
        assert len(rows["BTC"]) == 2
        with parquet.open("ab") as output:
            output.write(b"corrupt")
        rows, supplement = module.load_historical_l2(target)
        assert supplement["status"] == "rejected", supplement
        assert not rows["BTC"]
    print("Hyperliquid S3 archive audit tests passed")


def load_backtest_module(root):
    path = root / "scripts/backtest-hyperliquid-model.py"
    spec = importlib.util.spec_from_file_location("backtest_hyperliquid_model", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == "__main__":
    main()
