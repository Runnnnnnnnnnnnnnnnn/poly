#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import duckdb


def main():
    parser = argparse.ArgumentParser(description="Query the archived Polymarket Watch realtime Parquet dataset")
    parser.add_argument("--archive", default=str(Path.home() / ".polymarket-watch" / "parquet"))
    parser.add_argument("--sql", help="DuckDB SELECT query; views market_ticks and asset_ticks are pre-registered")
    args = parser.parse_args()
    archive = Path(args.archive).expanduser().resolve()
    connection = duckdb.connect(":memory:")
    connection.execute("SET TimeZone='UTC'")
    registered = set()
    for view, table in (("market_ticks", "realtime_market_tick"), ("asset_ticks", "realtime_asset_tick")):
        pattern = str(archive / f"table={table}" / "date=*" / "**" / "data.parquet")
        if not list((archive / f"table={table}").glob("date=*/**/data.parquet")):
            continue
        escaped_pattern = pattern.replace("'", "''")
        connection.execute(
            f"CREATE VIEW {view} AS SELECT * FROM read_parquet('{escaped_pattern}', hive_partitioning=false, union_by_name=true)"
        )
        registered.add(view)
    if "market_ticks" not in registered and not args.sql:
        print("[]")
        return
    query = args.sql or """
        SELECT CAST(capturedAt AS DATE) AS date, asset, count(*) AS rows, count(DISTINCT marketId) AS markets,
               min(capturedAt) AS first_at, max(capturedAt) AS latest_at
        FROM market_ticks
        GROUP BY 1, asset
        ORDER BY date DESC, asset
    """
    cursor = connection.execute(query)
    columns = [item[0] for item in cursor.description]
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
    print(json.dumps(rows, default=str, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
