#!/usr/bin/env python3
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

import pyarrow.parquet as pq


def file_sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory() as temporary:
        state = Path(temporary)
        database = state / "fixture.db"
        archive = state / "parquet"
        status = state / "status.json"
        with sqlite3.connect(database) as connection:
            connection.execute('CREATE TABLE "RealtimeMarketTick" ("id" TEXT PRIMARY KEY, "marketId" TEXT, "asset" TEXT, "capturedAt" DATETIME, "arbitrageViolation" BOOLEAN)')
            connection.execute('CREATE TABLE "RealtimeAssetTick" ("id" TEXT PRIMARY KEY, "asset" TEXT, "capturedAt" DATETIME)')
            connection.executemany(
                'INSERT INTO "RealtimeMarketTick" VALUES (?, ?, ?, ?, ?)',
                [
                    ("market-1", "m1", "BTC", 1782864001000, 0),
                    ("market-current", "m2", "ETH", 1782950401000, 1),
                ],
            )
            connection.execute('INSERT INTO "RealtimeAssetTick" VALUES (?, ?, ?)', ("asset-1", "BTC", 1782864002000))
        command = [
            sys.executable,
            str(root / "scripts/archive-realtime-data.py"),
            "--database", str(database),
            "--output", str(archive),
            "--status", str(status),
            "--now", "2026-07-02T12:00:00Z",
        ]
        first = json.loads(subprocess.check_output(command, text=True))
        assert first["status"] == "healthy"
        assert first["archivedThrough"] == "2026-07-01"
        assert first["partitions"] == 2
        assert first["rows"] == 2
        market_file = archive / "table=realtime_market_tick/date=2026-07-01/data.parquet"
        market_manifest = market_file.with_name("manifest.json")
        assert pq.ParquetFile(market_file).metadata.num_rows == 1
        table = pq.read_table(market_file)
        assert table.column("capturedAt").type.tz == "UTC"
        assert table.column("arbitrageViolation").to_pylist() == [False]
        initial_hash = file_sha256(market_file)
        second = json.loads(subprocess.check_output(command, text=True))
        assert second["rows"] == 2
        assert file_sha256(market_file) == initial_hash
        market_file.write_bytes(market_file.read_bytes() + b"corrupt")
        assert file_sha256(market_file) != json.loads(market_manifest.read_text())["sha256"]
        subprocess.check_output(command, text=True)
        assert file_sha256(market_file) == json.loads(market_manifest.read_text())["sha256"]
        queried = json.loads(subprocess.check_output([
            sys.executable,
            str(root / "scripts/query-realtime-archive.py"),
            "--archive", str(archive),
        ], text=True))
        expected_query = [{
            "date": "2026-07-01",
            "asset": "BTC",
            "rows": 1,
            "markets": 1,
            "first_at": "2026-07-01 00:00:01+00:00",
            "latest_at": "2026-07-01 00:00:01+00:00",
        }]
        assert queried == expected_query, queried
    print("columnar archive tests passed")


if __name__ == "__main__":
    main()
