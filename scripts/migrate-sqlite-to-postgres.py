#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    home = Path.home()
    parser = argparse.ArgumentParser(description="Migrate the verified runtime SQLite database to local PostgreSQL")
    parser.add_argument("--sqlite", default=str(home / ".polymarket-watch/runtime/prisma/dev.db"))
    parser.add_argument("--database-url-file", default=str(home / ".polymarket-watch/postgres/database-url"))
    parser.add_argument(
        "--psql",
        default=str(home / "Applications/Postgres.app/Contents/Versions/18/bin/psql"),
    )
    parser.add_argument("--audit-root", default=str(home / ".polymarket-watch/recovery"))
    return parser.parse_args()


def main():
    args = parse_args()
    sqlite_path = Path(args.sqlite).expanduser().resolve()
    database_url_file = Path(args.database_url_file).expanduser().resolve()
    psql = Path(args.psql).expanduser().resolve()
    audit_root = Path(args.audit_root).expanduser().resolve()
    if not sqlite_path.exists():
        raise FileNotFoundError(sqlite_path)
    if not database_url_file.exists():
        raise FileNotFoundError(database_url_file)
    if not psql.exists():
        raise FileNotFoundError(psql)

    postgres_url = database_url_file.read_text(encoding="utf-8").strip().split("?schema=", 1)[0]
    generated_at = datetime.now(timezone.utc)
    audit_root.mkdir(parents=True, exist_ok=True)
    audit_path = audit_root / f"postgres-migration-{generated_at.strftime('%Y-%m-%dT%H-%M-%SZ')}.json"

    with tempfile.TemporaryDirectory(prefix="polymarket-postgres-migration-") as temporary:
        temporary_path = Path(temporary)
        with sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True, timeout=60) as source:
            source.execute("PRAGMA query_only=ON")
            source.execute("PRAGMA busy_timeout=60000")
            integrity = source.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"SQLite integrity check failed: {integrity}")
            tables = [
                row[0]
                for row in source.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            ]
            exports = [export_table(source, table, temporary_path) for table in tables]

        migration_sql = temporary_path / "migrate.sql"
        migration_sql.write_text(build_migration_sql(exports), encoding="utf-8")
        subprocess.run(
            [str(psql), postgres_url, "-v", "ON_ERROR_STOP=1", "-f", str(migration_sql)],
            check=True,
            text=True,
        )

        postgres_counts = read_postgres_counts(psql, postgres_url, tables)
        mismatches = [
            {"table": item["table"], "sqlite": item["rows"], "postgres": postgres_counts.get(item["table"])}
            for item in exports
            if postgres_counts.get(item["table"]) != item["rows"]
        ]
        if mismatches:
            raise RuntimeError(f"PostgreSQL row count mismatch: {mismatches}")

        audit = {
            "schemaVersion": 1,
            "status": "verified",
            "generatedAt": generated_at.isoformat(),
            "sqlite": str(sqlite_path),
            "sqliteBytes": sqlite_path.stat().st_size,
            "sqliteSha256": file_sha256(sqlite_path),
            "postgres": "127.0.0.1:55432/polymarket_watch",
            "tables": len(exports),
            "rows": sum(item["rows"] for item in exports),
            "tableCounts": {item["table"]: item["rows"] for item in exports},
            "verified": not mismatches,
        }
        audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(audit_path, 0o600)
        print(json.dumps({"auditPath": str(audit_path), **audit}, ensure_ascii=False, indent=2))


def export_table(connection, table, target_directory):
    quoted_table = quote_identifier(table)
    columns = connection.execute(f"PRAGMA table_info({quoted_table})").fetchall()
    names = [column[1] for column in columns]
    types = [str(column[2]).upper() for column in columns]
    output = target_directory / f"{table}.csv"
    rows = 0
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        cursor = connection.execute(f"SELECT * FROM {quoted_table}")
        for record in cursor:
            writer.writerow([convert_value(value, declared_type) for value, declared_type in zip(record, types)])
            rows += 1
    return {"table": table, "columns": names, "file": str(output), "rows": rows}


def convert_value(value, declared_type):
    if value is None:
        return "__POLYMARKET_NULL__"
    if "DATETIME" in declared_type:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds")
        return str(value)
    if "BOOLEAN" in declared_type:
        return "true" if bool(value) else "false"
    return value


def build_migration_sql(exports):
    table_list = ", ".join(quote_identifier(item["table"]) for item in exports)
    commands = [
        "\\set ON_ERROR_STOP on",
        "BEGIN;",
        "SET session_replication_role = replica;",
        f"TRUNCATE {table_list} CASCADE;",
    ]
    for item in exports:
        columns = ", ".join(quote_identifier(column) for column in item["columns"])
        file_path = item["file"].replace("'", "''")
        commands.append(
            f"\\copy {quote_identifier(item['table'])} ({columns}) "
            f"FROM '{file_path}' WITH (FORMAT csv, NULL '__POLYMARKET_NULL__')"
        )
    commands.extend(["SET session_replication_role = origin;", "COMMIT;"])
    return "\n".join(commands) + "\n"


def read_postgres_counts(psql, database_url, tables):
    def count_statement(table):
        table_literal = table.replace("'", "''")
        return f"SELECT '{table_literal}', COUNT(*)::bigint FROM {quote_identifier(table)}"

    union = " UNION ALL ".join(
        count_statement(table)
        for table in tables
    )
    result = subprocess.run(
        [str(psql), database_url, "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", union],
        check=True,
        capture_output=True,
        text=True,
    )
    return {line.split("|", 1)[0]: int(line.split("|", 1)[1]) for line in result.stdout.splitlines() if line}


def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
