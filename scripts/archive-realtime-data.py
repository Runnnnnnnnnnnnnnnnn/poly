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
import psycopg


SCHEMA_VERSION = 1
TABLES = {
    "RealtimeMarketTick": "realtime_market_tick",
    "RealtimeAssetTick": "realtime_asset_tick",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Archive completed realtime tick hours to verified Parquet partitions")
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
    if is_postgres(connection):
        rows = connection.execute(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position",
            (table,),
        ).fetchall()
        if not rows:
            raise RuntimeError(f"PostgreSQL table is missing: {table}")
        return [(row[0], str(row[1]).upper()) for row in rows]
    rows = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
    if not rows:
        raise RuntimeError(f"SQLite table is missing: {table}")
    return [(row[1], str(row[2]).upper()) for row in rows]


def convert_value(value, declared_type):
    if value is None:
        return None
    if declared_type == "DATETIME" or "TIMESTAMP" in declared_type:
        if isinstance(value, datetime):
            return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc)
        return datetime.fromtimestamp(int(value) / 1000, timezone.utc)
    if declared_type == "BOOLEAN":
        return bool(value)
    return value


def source_summary(connection, table, start, end):
    return connection.execute(
        f'SELECT COUNT(*), MIN("capturedAt"), MAX("capturedAt") FROM "{table}" '
        f'WHERE "capturedAt" >= {placeholder(connection)} AND "capturedAt" < {placeholder(connection)}',
        (source_boundary(connection, start), source_boundary(connection, end)),
    ).fetchone()


def valid_existing_partition(data_path, manifest_path, expected):
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != SCHEMA_VERSION:
            return None
        for key in ("table", "date", "hour", "rowCount", "minimumCapturedAt", "maximumCapturedAt"):
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


def archive_partition(connection, output_root, table, dataset_name, start, columns):
    end = start + timedelta(hours=1)
    count, minimum, maximum = source_summary(connection, table, start, end)
    if not count:
        return None
    day = start.date()
    partition = output_root / f"table={dataset_name}" / f"date={day.isoformat()}" / f"hour={start.hour:02d}"
    data_path = partition / "data.parquet"
    manifest_path = partition / "manifest.json"
    expected = {
        "table": table,
        "date": day.isoformat(),
        "hour": start.hour,
        "rowCount": int(count),
        "minimumCapturedAt": epoch_milliseconds(minimum),
        "maximumCapturedAt": epoch_milliseconds(maximum),
    }
    existing = valid_existing_partition(data_path, manifest_path, expected)
    if existing:
        return existing

    names = [name for name, _ in columns]
    selected_columns = ", ".join('"{}"'.format(name.replace('"', '""')) for name in names)
    rows = connection.execute(
        f'SELECT {selected_columns} FROM "{table}" '
        f'WHERE "capturedAt" >= {placeholder(connection)} AND "capturedAt" < {placeholder(connection)} '
        'ORDER BY "capturedAt", "id"',
        (source_boundary(connection, start), source_boundary(connection, end)),
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


def completed_hours(connection, table, completed_before):
    minimum, maximum = connection.execute(
        f'SELECT MIN("capturedAt"), MAX("capturedAt") FROM "{table}"'
    ).fetchone()
    if minimum is None or maximum is None:
        return []
    first = source_datetime(minimum).replace(minute=0, second=0, microsecond=0)
    last_observed = source_datetime(maximum).replace(minute=0, second=0, microsecond=0)
    last = min(last_observed, completed_before - timedelta(hours=1))
    if first > last:
        return []
    hours = int((last - first).total_seconds() // 3600)
    return [first + timedelta(hours=offset) for offset in range(hours + 1)]


def run(args):
    now = utc_now(args.now)
    completed_before = now.replace(minute=0, second=0, microsecond=0)
    database_source = args.database
    output_root = Path(args.output).expanduser().resolve()
    status_path = Path(args.status).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    manifests = []
    with source_connection(database_source) as connection:
        for table, dataset_name in TABLES.items():
            columns = declared_columns(connection, table)
            for hour in completed_hours(connection, table, completed_before):
                daily_partition = output_root / f"table={dataset_name}" / f"date={hour.date().isoformat()}" / "data.parquet"
                if daily_partition.exists():
                    continue
                manifest = archive_partition(connection, output_root, table, dataset_name, hour, columns)
                if manifest:
                    manifests.append(manifest)
    all_manifests = load_verified_manifests(output_root)
    archived_dates = sorted({manifest["date"] for manifest in all_manifests})
    total_rows = sum(int(manifest["rowCount"]) for manifest in all_manifests)
    total_size = sum(int(manifest["sizeBytes"]) for manifest in all_manifests)
    status = {
        "status": "healthy",
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "archivedThrough": archived_dates[-1] if archived_dates else None,
        "partitions": len(all_manifests),
        "rows": total_rows,
        "sizeBytes": total_size,
        "outputRoot": str(output_root),
        "message": "completed UTC partitions verified" if manifests else "waiting for the first completed UTC hour",
    }
    atomic_text(status_path, f"{json.dumps(status, ensure_ascii=True, indent=2)}\n")
    return status


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


def epoch_milliseconds(value):
    return int(source_datetime(value).timestamp() * 1000)


def load_verified_manifests(output_root):
    manifests = []
    for manifest_path in output_root.glob("table=*/date=*/**/manifest.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            data_path = manifest_path.parent / "data.parquet"
            if data_path.is_file() and manifest.get("sha256") == sha256_file(data_path):
                manifests.append(manifest)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return manifests


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
