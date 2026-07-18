#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


SCHEMA_VERSION = 1
TABLES = {
    "RealtimeMarketTick": "realtime_market_tick",
    "RealtimeAssetTick": "realtime_asset_tick",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Archive completed realtime tick days to verified Parquet partitions")
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--status", required=True)
    parser.add_argument("--now", help="ISO-8601 UTC time used for deterministic tests")
    return parser.parse_args()


def utc_now(value):
    if not value:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def atomic_text(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def declared_columns(connection, table):
    rows = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
    if not rows:
        raise RuntimeError(f"SQLite table is missing: {table}")
    return [(row[1], str(row[2]).upper()) for row in rows]


def convert_value(value, declared_type):
    if value is None:
        return None
    if declared_type == "DATETIME":
        return datetime.fromtimestamp(int(value) / 1000, timezone.utc)
    if declared_type == "BOOLEAN":
        return bool(value)
    return value


def source_summary(connection, table, start_ms, end_ms):
    return connection.execute(
        f'SELECT COUNT(*), MIN("capturedAt"), MAX("capturedAt") FROM "{table}" '
        'WHERE "capturedAt" >= ? AND "capturedAt" < ?',
        (start_ms, end_ms),
    ).fetchone()


def valid_existing_partition(data_path, manifest_path, expected):
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != SCHEMA_VERSION:
            return None
        for key in ("table", "date", "rowCount", "minimumCapturedAt", "maximumCapturedAt"):
            if manifest.get(key) != expected.get(key):
                return None
        if not data_path.is_file() or manifest.get("sha256") != sha256_file(data_path):
            return None
        metadata = pq.ParquetFile(data_path).metadata
        if metadata.num_rows != expected["rowCount"]:
            return None
        return manifest
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def archive_partition(connection, output_root, table, dataset_name, day, columns):
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    count, minimum, maximum = source_summary(connection, table, start_ms, end_ms)
    if not count:
        return None
    partition = output_root / f"table={dataset_name}" / f"date={day.isoformat()}"
    data_path = partition / "data.parquet"
    manifest_path = partition / "manifest.json"
    expected = {
        "table": table,
        "date": day.isoformat(),
        "rowCount": int(count),
        "minimumCapturedAt": int(minimum),
        "maximumCapturedAt": int(maximum),
    }
    existing = valid_existing_partition(data_path, manifest_path, expected)
    if existing:
        return existing

    names = [name for name, _ in columns]
    selected_columns = ", ".join('"{}"'.format(name.replace('"', '""')) for name in names)
    rows = connection.execute(
        f'SELECT {selected_columns} FROM "{table}" '
        'WHERE "capturedAt" >= ? AND "capturedAt" < ? ORDER BY "capturedAt", "id"',
        (start_ms, end_ms),
    ).fetchall()
    records = [
        {name: convert_value(value, declared_type) for (name, declared_type), value in zip(columns, row)}
        for row in rows
    ]
    arrow_table = pa.Table.from_pylist(records)
    metadata = dict(arrow_table.schema.metadata or {})
    metadata.update({
        b"polymarket_watch.schema_version": str(SCHEMA_VERSION).encode(),
        b"polymarket_watch.source_table": table.encode(),
        b"polymarket_watch.partition_date": day.isoformat().encode(),
    })
    arrow_table = arrow_table.replace_schema_metadata(metadata)
    partition.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".data.", suffix=".parquet.tmp", dir=partition)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        pq.write_table(
            arrow_table,
            temporary,
            compression="zstd",
            use_dictionary=True,
            write_statistics=True,
            row_group_size=100_000,
        )
        written = pq.ParquetFile(temporary)
        if written.metadata.num_rows != count:
            raise RuntimeError(f"Parquet row verification failed for {table} {day.isoformat()}")
        os.replace(temporary, data_path)
    finally:
        temporary.unlink(missing_ok=True)

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        **expected,
        "columns": names,
        "sha256": sha256_file(data_path),
        "sizeBytes": data_path.stat().st_size,
        "compression": "zstd",
        "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    atomic_text(manifest_path, f"{json.dumps(manifest, ensure_ascii=True, indent=2)}\n")
    verified = valid_existing_partition(data_path, manifest_path, expected)
    if not verified:
        raise RuntimeError(f"Parquet checksum verification failed for {table} {day.isoformat()}")
    return verified


def completed_days(connection, table, completed_before):
    minimum, maximum = connection.execute(
        f'SELECT MIN("capturedAt"), MAX("capturedAt") FROM "{table}"'
    ).fetchone()
    if minimum is None or maximum is None:
        return []
    first = datetime.fromtimestamp(int(minimum) / 1000, timezone.utc).date()
    last_observed = datetime.fromtimestamp(int(maximum) / 1000, timezone.utc).date()
    last = min(last_observed, completed_before - timedelta(days=1))
    if first > last:
        return []
    return [first + timedelta(days=offset) for offset in range((last - first).days + 1)]


def run(args):
    now = utc_now(args.now)
    completed_before = now.date()
    database = Path(args.database).expanduser().resolve()
    output_root = Path(args.output).expanduser().resolve()
    status_path = Path(args.status).expanduser().resolve()
    if not database.is_file():
        raise FileNotFoundError(f"SQLite database not found: {database}")
    output_root.mkdir(parents=True, exist_ok=True)
    uri = f"file:{database}?mode=ro"
    manifests = []
    with sqlite3.connect(uri, uri=True, timeout=30) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        for table, dataset_name in TABLES.items():
            columns = declared_columns(connection, table)
            for day in completed_days(connection, table, completed_before):
                manifest = archive_partition(connection, output_root, table, dataset_name, day, columns)
                if manifest:
                    manifests.append(manifest)
    archived_dates = sorted({manifest["date"] for manifest in manifests})
    total_rows = sum(int(manifest["rowCount"]) for manifest in manifests)
    total_size = sum(int(manifest["sizeBytes"]) for manifest in manifests)
    status = {
        "status": "healthy",
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "archivedThrough": archived_dates[-1] if archived_dates else None,
        "partitions": len(manifests),
        "rows": total_rows,
        "sizeBytes": total_size,
        "outputRoot": str(output_root),
        "message": "completed UTC partitions verified" if manifests else "waiting for the first completed UTC day",
    }
    atomic_text(status_path, f"{json.dumps(status, ensure_ascii=True, indent=2)}\n")
    return status


def main():
    args = parse_args()
    try:
        status = run(args)
        print(json.dumps(status, separators=(",", ":")))
        return 0
    except Exception as error:
        failed = {
            "status": "error",
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": utc_now(args.now).isoformat().replace("+00:00", "Z"),
            "verifiedAt": None,
            "archivedThrough": None,
            "partitions": 0,
            "rows": 0,
            "sizeBytes": 0,
            "message": str(error),
        }
        try:
            atomic_text(Path(args.status).expanduser().resolve(), f"{json.dumps(failed, ensure_ascii=True, indent=2)}\n")
        except Exception:
            pass
        print(json.dumps(failed, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
