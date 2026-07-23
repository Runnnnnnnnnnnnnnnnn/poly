#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.dataset as ds
import psycopg


MARKET_COLUMNS = [
    "id",
    "eventId",
    "marketId",
    "asset",
    "marketStartAt",
    "marketEndAt",
    "polymarketBestBid",
    "polymarketBestAsk",
    "polymarketUpdatedAt",
    "negativeBestBid",
    "negativeBestAsk",
    "negativeUpdatedAt",
    "hyperliquidBestBid",
    "hyperliquidBestAsk",
    "hyperliquidMidPrice",
    "hyperliquidFundingRate",
    "hyperliquidUpdatedAt",
    "chainlinkPrice",
    "chainlinkUpdatedAt",
    "referencePrice",
    "referenceUpdatedAt",
    "captureSkewMs",
    "capturedAt",
]
ASSET_COLUMNS = [
    "id",
    "asset",
    "hyperliquidBestBid",
    "hyperliquidBestAsk",
    "hyperliquidMidPrice",
    "hyperliquidUpdatedAt",
    "chainlinkPrice",
    "chainlinkUpdatedAt",
    "captureSkewMs",
    "capturedAt",
]
DATE_COLUMNS = {
    "marketStartAt",
    "marketEndAt",
    "polymarketUpdatedAt",
    "negativeUpdatedAt",
    "hyperliquidUpdatedAt",
    "chainlinkUpdatedAt",
    "referenceUpdatedAt",
    "capturedAt",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Build a deduplicated realtime replay input from Parquet and SQLite")
    parser.add_argument("--database", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--market-sync", required=True)
    parser.add_argument("--asset-sync", required=True)
    parser.add_argument("--lookback-days", type=int, default=30)
    parser.add_argument("--now", help="ISO-8601 UTC upper boundary used for deterministic tests")
    return parser.parse_args()


def utc_time(value):
    if not value:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, default=json_value, ensure_ascii=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def json_value(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def source_rows(connection, table, columns, synchronization_version, since, before):
    selected = ", ".join(f'"{column}"' for column in columns)
    rows = connection.execute(
        f'SELECT {selected} FROM "{table}" '
        f'WHERE "synchronizationVersion" = {placeholder(connection)} '
        f'AND "capturedAt" >= {placeholder(connection)} AND "capturedAt" < {placeholder(connection)} '
        'ORDER BY "capturedAt", "id"',
        (synchronization_version, source_boundary(connection, since), source_boundary(connection, before)),
    ).fetchall()
    return [normalize_record(dict(zip(columns, row))) for row in rows]


def minimum_source_capture(connection, table, synchronization_version, since, before):
    row = connection.execute(
        f'SELECT MIN("capturedAt") FROM "{table}" '
        f'WHERE "synchronizationVersion" = {placeholder(connection)} '
        f'AND "capturedAt" >= {placeholder(connection)} AND "capturedAt" < {placeholder(connection)}',
        (synchronization_version, source_boundary(connection, since), source_boundary(connection, before)),
    ).fetchone()
    return source_datetime(row[0]) if row and row[0] is not None else None


def parquet_rows(archive, dataset_name, columns, synchronization_version, since, before, source_minimum):
    files = sorted((archive / f"table={dataset_name}").glob("date=*/**/data.parquet"))
    if not files:
        return []
    dataset = ds.dataset([str(path) for path in files], format="parquet")
    expression = (
        (ds.field("synchronizationVersion") == synchronization_version)
        & (ds.field("capturedAt") >= pa.scalar(since))
        & (ds.field("capturedAt") < pa.scalar(before))
    )
    if source_minimum is not None:
        expression = expression & (ds.field("capturedAt") < pa.scalar(source_minimum))
    table = dataset.to_table(columns=columns, filter=expression)
    return [normalize_record(record) for record in table.to_pylist()]


def normalize_record(record):
    normalized = dict(record)
    for key in DATE_COLUMNS:
        value = normalized.get(key)
        if value is None or isinstance(value, datetime):
            continue
        if isinstance(value, (int, float)):
            normalized[key] = datetime.fromtimestamp(int(value) / 1000, timezone.utc)
        elif isinstance(value, str):
            normalized[key] = utc_time(value)
    return normalized


def merge_rows(archived, current):
    merged = {str(row["id"]): row for row in archived}
    merged.update({str(row["id"]): row for row in current})
    rows = sorted(merged.values(), key=lambda row: (row["capturedAt"], str(row["id"])))
    return rows, len(archived) + len(current) - len(rows)


def source_summary(archived, current, merged, duplicates):
    captured = [row["capturedAt"] for row in merged]
    return {
        "archiveRows": len(archived),
        "sqliteRows": len(current),
        "mergedRows": len(merged),
        "duplicatesRemoved": duplicates,
        "firstCapturedAt": min(captured) if captured else None,
        "latestCapturedAt": max(captured) if captured else None,
    }


def run(args):
    now = utc_time(args.now)
    lookback_days = max(0, args.lookback_days)
    since = datetime(1970, 1, 1, tzinfo=timezone.utc) if lookback_days == 0 else now - timedelta(days=lookback_days)
    database_source = args.database
    database_mode = "postgres" if database_source.startswith(("postgresql://", "postgres://")) else "sqlite"
    archive = Path(args.archive).expanduser().resolve()
    with source_connection(database_source) as connection:
        market_minimum = minimum_source_capture(
            connection, "RealtimeMarketTick", args.market_sync, since, now
        )
        asset_minimum = minimum_source_capture(
            connection, "RealtimeAssetTick", args.asset_sync, since, now
        )
        current_market = source_rows(
            connection, "RealtimeMarketTick", MARKET_COLUMNS, args.market_sync, since, now
        )
        current_asset = source_rows(
            connection, "RealtimeAssetTick", ASSET_COLUMNS, args.asset_sync, since, now
        )

    archived_market = parquet_rows(
        archive, "realtime_market_tick", MARKET_COLUMNS, args.market_sync, since, now, market_minimum
    )
    archived_asset = parquet_rows(
        archive, "realtime_asset_tick", ASSET_COLUMNS, args.asset_sync, since, now, asset_minimum
    )
    market_ticks, market_duplicates = merge_rows(archived_market, current_market)
    asset_ticks, asset_duplicates = merge_rows(archived_asset, current_asset)
    market_source = source_summary(archived_market, current_market, market_ticks, market_duplicates)
    asset_source = source_summary(archived_asset, current_asset, asset_ticks, asset_duplicates)
    archive_rows = market_source["archiveRows"] + asset_source["archiveRows"]
    sqlite_rows_count = market_source["sqliteRows"] + asset_source["sqliteRows"]
    archive_partitions = len(list(archive.glob("table=*/date=*/**/data.parquet")))
    mode = "hybrid" if archive_rows and sqlite_rows_count else "parquet" if archive_rows else database_mode
    payload = {
        "schemaVersion": 1,
        "generatedAt": now,
        "provenance": {
            "mode": mode,
            "archivePartitions": archive_partitions,
            "lookbackDays": lookback_days,
            "sinceAt": since,
            "beforeAt": now,
            "marketTicks": market_source,
            "assetTicks": asset_source,
            "databaseMode": database_mode,
        },
        "marketTicks": market_ticks,
        "assetTicks": asset_ticks,
    }
    atomic_json(Path(args.output).expanduser().resolve(), payload)
    return payload["provenance"]


def source_connection(database_source):
    if database_source.startswith(("postgresql://", "postgres://")):
        connection = psycopg.connect(database_source.split("?schema=", 1)[0], autocommit=True)
        connection.execute("SET TIME ZONE 'UTC'")
        return connection
    database_value = database_source[5:] if database_source.startswith("file:") else database_source
    database = Path(database_value).expanduser().resolve()
    if not database.is_file():
        raise FileNotFoundError(f"SQLite database not found: {database}")
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=30)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def is_postgres(connection):
    return connection.__class__.__module__.startswith("psycopg")


def placeholder(connection):
    return "%s" if is_postgres(connection) else "?"


def source_boundary(connection, value):
    return value.replace(tzinfo=None) if is_postgres(connection) else int(value.timestamp() * 1000)


def source_datetime(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc)
    return datetime.fromtimestamp(int(value) / 1000, timezone.utc)


def main():
    args = parse_args()
    provenance = run(args)
    print(json.dumps(provenance, default=json_value, separators=(",", ":")))


if __name__ == "__main__":
    main()
