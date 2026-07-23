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
        replay_input = state / "replay-input.json"
        with sqlite3.connect(database) as connection:
            connection.execute('''CREATE TABLE "RealtimeMarketTick" (
                "id" TEXT PRIMARY KEY,
                "eventId" TEXT,
                "marketId" TEXT,
                "asset" TEXT,
                "marketStartAt" DATETIME,
                "marketEndAt" DATETIME,
                "polymarketBestBid" REAL,
                "polymarketBestAsk" REAL,
                "polymarketUpdatedAt" DATETIME,
                "negativeBestBid" REAL,
                "negativeBestAsk" REAL,
                "negativeUpdatedAt" DATETIME,
                "hyperliquidBestBid" REAL,
                "hyperliquidBestAsk" REAL,
                "hyperliquidMidPrice" REAL,
                "hyperliquidFundingRate" REAL,
                "hyperliquidUpdatedAt" DATETIME,
                "chainlinkPrice" REAL,
                "chainlinkUpdatedAt" DATETIME,
                "referencePrice" REAL,
                "referenceUpdatedAt" DATETIME,
                "captureSkewMs" INTEGER,
                "synchronizationVersion" TEXT,
                "capturedAt" DATETIME,
                "arbitrageViolation" BOOLEAN
            )''')
            connection.execute('''CREATE TABLE "RealtimeAssetTick" (
                "id" TEXT PRIMARY KEY,
                "asset" TEXT,
                "hyperliquidBestBid" REAL,
                "hyperliquidBestAsk" REAL,
                "hyperliquidMidPrice" REAL,
                "hyperliquidUpdatedAt" DATETIME,
                "chainlinkPrice" REAL,
                "chainlinkUpdatedAt" DATETIME,
                "captureSkewMs" INTEGER,
                "synchronizationVersion" TEXT,
                "capturedAt" DATETIME
            )''')
            connection.executemany(
                'INSERT INTO "RealtimeMarketTick" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    market_row("market-1", "m1", "BTC", 1782864001000, 0),
                    market_row("market-current", "m2", "ETH", 1782950401000, 1),
                ],
            )
            connection.executemany(
                'INSERT INTO "RealtimeAssetTick" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    asset_row("asset-1", "BTC", 1782864002000),
                    asset_row("asset-current", "ETH", 1782950402000),
                ],
            )
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
        assert first["archivedThrough"] == "2026-07-02"
        assert first["partitions"] == 4
        assert first["rows"] == 4
        market_file = archive / "table=realtime_market_tick/date=2026-07-01/hour=00/data.parquet"
        market_manifest = market_file.with_name("manifest.json")
        assert pq.ParquetFile(market_file).metadata.num_rows == 1
        table = pq.read_table(market_file)
        assert table.column("capturedAt").type.tz == "UTC"
        assert table.column("arbitrageViolation").to_pylist() == [False]
        initial_hash = file_sha256(market_file)
        second = json.loads(subprocess.check_output(command, text=True))
        assert second["rows"] == 4
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
            "date": "2026-07-02",
            "asset": "ETH",
            "rows": 1,
            "markets": 1,
            "first_at": "2026-07-02 00:00:01+00:00",
            "latest_at": "2026-07-02 00:00:01+00:00",
        }, {
            "date": "2026-07-01",
            "asset": "BTC",
            "rows": 1,
            "markets": 1,
            "first_at": "2026-07-01 00:00:01+00:00",
            "latest_at": "2026-07-01 00:00:01+00:00",
        }]
        assert queried == expected_query, queried
        export_command = [
            sys.executable,
            str(root / "scripts/export-realtime-replay-input.py"),
            "--database", str(database),
            "--archive", str(archive),
            "--output", str(replay_input),
            "--market-sync", "websocket-v6-near-term-discovery",
            "--asset-sync", "websocket-asset-v1",
            "--lookback-days", "30",
            "--now", "2026-07-02T12:00:00Z",
        ]
        overlap = json.loads(subprocess.check_output(export_command, text=True))
        assert overlap["mode"] == "sqlite"
        assert overlap["archivePartitions"] == 4
        assert overlap["marketTicks"]["mergedRows"] == 2
        assert overlap["assetTicks"]["mergedRows"] == 2

        with sqlite3.connect(database) as connection:
            connection.execute('DELETE FROM "RealtimeMarketTick" WHERE "id" = ?', ("market-1",))
            connection.execute('DELETE FROM "RealtimeAssetTick" WHERE "id" = ?', ("asset-1",))
        retained = json.loads(subprocess.check_output(export_command, text=True))
        assert retained["mode"] == "hybrid"
        assert retained["marketTicks"]["archiveRows"] == 1
        assert retained["marketTicks"]["sqliteRows"] == 1
        assert retained["marketTicks"]["mergedRows"] == 2
        assert retained["assetTicks"]["archiveRows"] == 1
        assert retained["assetTicks"]["sqliteRows"] == 1
        assert retained["assetTicks"]["mergedRows"] == 2
        payload = json.loads(replay_input.read_text())
        assert [row["id"] for row in payload["marketTicks"]] == ["market-1", "market-current"]
        assert [row["id"] for row in payload["assetTicks"]] == ["asset-1", "asset-current"]
        assert payload["marketTicks"][0]["capturedAt"] == "2026-07-01T00:00:01Z"
    print("columnar archive tests passed")


def market_row(identifier, market_id, asset, captured_at, arbitrage_violation):
    return (
        identifier,
        f"event-{market_id}",
        market_id,
        asset,
        captured_at - 60_000,
        captured_at + 840_000,
        0.49,
        0.51,
        captured_at,
        0.49,
        0.51,
        captured_at,
        100.0,
        100.1,
        100.05,
        0.00001,
        captured_at,
        100.0,
        captured_at,
        100.0,
        captured_at,
        10,
        "websocket-v6-near-term-discovery",
        captured_at,
        arbitrage_violation,
    )


def asset_row(identifier, asset, captured_at):
    return (
        identifier,
        asset,
        100.0,
        100.1,
        100.05,
        captured_at,
        100.0,
        captured_at,
        10,
        "websocket-asset-v1",
        captured_at,
    )


if __name__ == "__main__":
    main()
