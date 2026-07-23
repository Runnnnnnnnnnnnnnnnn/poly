#!/usr/bin/env python3
import argparse
import hashlib
import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import lz4.frame
import pyarrow as pa
import pyarrow.parquet as pq


def parse_args():
    parser = argparse.ArgumentParser(
        description="Download and verify requester-pays Hyperliquid L2 archives before model use"
    )
    parser.add_argument("--date", required=True, help="UTC date in YYYYMMDD format")
    parser.add_argument("--assets", default="BTC,ETH,SOL,XRP")
    parser.add_argument("--hours", default="0-23", help="Comma-separated hours or inclusive range")
    parser.add_argument("--root", default=str(Path.home() / ".polymarket-watch/hyperliquid-s3"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument(
        "--accept-requester-pays",
        action="store_true",
        help="Required with --download because AWS transfer charges may apply",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    if args.download and not args.accept_requester_pays:
        raise SystemExit("--download requires --accept-requester-pays")
    parsed_date = datetime.strptime(args.date, "%Y%m%d").replace(tzinfo=timezone.utc)
    assets = [asset.strip().upper() for asset in args.assets.split(",") if asset.strip()]
    hours = parse_hours(args.hours)
    root = Path(args.root).expanduser().resolve()
    reports = []
    for hour in hours:
        for asset in assets:
            reports.append(process_object(root, parsed_date, hour, asset, args.download))
    accepted = [report for report in reports if report["status"] == "accepted"]
    missing = [report for report in reports if report["status"] == "missing"]
    rejected = [report for report in reports if report["status"] == "rejected"]
    result = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "s3://hyperliquid-archive/market_data",
        "requesterPays": True,
        "date": args.date,
        "requestedObjects": len(reports),
        "acceptedObjects": len(accepted),
        "missingObjects": len(missing),
        "rejectedObjects": len(rejected),
        "acceptedRows": sum(report.get("rows", 0) for report in accepted),
        "status": "healthy" if len(accepted) == len(reports) else "partial" if accepted else "unavailable",
        "objects": reports,
    }
    status_path = root / "status" / f"{args.date}.json"
    status_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_text(status_path, json.dumps(result, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps(result, separators=(",", ":"), ensure_ascii=True))


def process_object(root, parsed_date, hour, asset, download):
    date = parsed_date.strftime("%Y%m%d")
    object_key = f"market_data/{date}/{hour}/l2Book/{asset}.lz4"
    raw_path = root / "raw" / date / str(hour) / "l2Book" / f"{asset}.lz4"
    if not raw_path.is_file() and download:
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run([
            str(Path.home() / ".local/bin/aws"),
            "s3", "cp",
            f"s3://hyperliquid-archive/{object_key}",
            str(raw_path),
            "--request-payer", "requester",
            "--only-show-errors",
        ], text=True, capture_output=True)
        if result.returncode != 0:
            raw_path.unlink(missing_ok=True)
            return object_report(object_key, asset, hour, "missing", error=result.stderr.strip()[:500])
    if not raw_path.is_file():
        return object_report(object_key, asset, hour, "missing", error="local archive is not present")
    try:
        rows, audit = read_l2_rows(raw_path, parsed_date, hour, asset)
        if not rows:
            return object_report(object_key, asset, hour, "rejected", error="archive has no valid rows", **audit)
        if audit["invalidRows"] or audit["crossedBooks"] or audit["outOfHourRows"]:
            return object_report(object_key, asset, hour, "rejected", error="integrity checks failed", **audit)
        output = root / "verified" / f"date={date}" / f"hour={hour:02d}" / f"{asset}.parquet"
        output.parent.mkdir(parents=True, exist_ok=True)
        write_parquet(output, rows)
        return object_report(
            object_key,
            asset,
            hour,
            "accepted",
            rows=len(rows),
            rawSha256=sha256(raw_path),
            parquetSha256=sha256(output),
            firstAt=rows[0]["capturedAt"].isoformat().replace("+00:00", "Z"),
            lastAt=rows[-1]["capturedAt"].isoformat().replace("+00:00", "Z"),
            **audit,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        return object_report(object_key, asset, hour, "rejected", error=str(error)[:500])


def read_l2_rows(path, parsed_date, expected_hour, expected_asset):
    rows = []
    invalid = 0
    crossed = 0
    out_of_hour = 0
    duplicates = 0
    seen = set()
    with lz4.frame.open(path, mode="rt", encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
                data = payload.get("data", payload)
                asset = str(data["coin"]).upper()
                captured_at = datetime.fromtimestamp(int(data["time"]) / 1000, timezone.utc)
                levels = data["levels"]
                bids = normalize_levels(levels[0], reverse=True)
                asks = normalize_levels(levels[1], reverse=False)
                if asset != expected_asset or not bids or not asks:
                    invalid += 1
                    continue
                if captured_at.date() != parsed_date.date() or captured_at.hour != expected_hour:
                    out_of_hour += 1
                    continue
                if asks[0][0] < bids[0][0]:
                    crossed += 1
                    continue
                identifier = (asset, int(data["time"]))
                if identifier in seen:
                    duplicates += 1
                    continue
                seen.add(identifier)
                bid_depth5 = depth(bids[:5])
                ask_depth5 = depth(asks[:5])
                bid_depth10 = depth(bids[:10])
                ask_depth10 = depth(asks[:10])
                denominator = bids[0][1] + asks[0][1]
                microprice = (
                    (asks[0][0] * bids[0][1] + bids[0][0] * asks[0][1]) / denominator
                    if denominator > 0
                    else (bids[0][0] + asks[0][0]) / 2
                )
                rows.append({
                    "asset": asset,
                    "capturedAt": captured_at,
                    "bestBid": bids[0][0],
                    "bestAsk": asks[0][0],
                    "spread": asks[0][0] - bids[0][0],
                    "bidDepth5": bid_depth5,
                    "askDepth5": ask_depth5,
                    "bidDepth10": bid_depth10,
                    "askDepth10": ask_depth10,
                    "imbalance5": imbalance(bid_depth5, ask_depth5),
                    "imbalance10": imbalance(bid_depth10, ask_depth10),
                    "microprice": microprice,
                    "levels": min(10, len(bids), len(asks)),
                })
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                invalid += 1
    rows.sort(key=lambda row: row["capturedAt"])
    return rows, {
        "invalidRows": invalid,
        "crossedBooks": crossed,
        "outOfHourRows": out_of_hour,
        "duplicateRows": duplicates,
    }


def normalize_levels(values, reverse):
    rows = []
    for level in values:
        price = float(level["px"])
        size = float(level["sz"])
        if price > 0 and size > 0:
            rows.append((price, size))
    return sorted(rows, key=lambda row: row[0], reverse=reverse)[:10]


def write_parquet(path, rows):
    table = pa.Table.from_pylist(rows)
    with tempfile.NamedTemporaryFile(prefix=".l2.", suffix=".parquet", dir=path.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        pq.write_table(table, temporary_path, compression="zstd", write_statistics=True)
        if pq.ParquetFile(temporary_path).metadata.num_rows != len(rows):
            raise RuntimeError("Parquet row verification failed")
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def parse_hours(value):
    hours = []
    for part in value.split(","):
        part = part.strip()
        if "-" in part:
            start, end = [int(item) for item in part.split("-", 1)]
            hours.extend(range(start, end + 1))
        elif part:
            hours.append(int(part))
    normalized = sorted(set(hours))
    if not normalized or any(hour < 0 or hour > 23 for hour in normalized):
        raise SystemExit("--hours must contain values from 0 to 23")
    return normalized


def depth(levels):
    return sum(price * size for price, size in levels)


def imbalance(bid, ask):
    return (bid - ask) / (bid + ask) if bid + ask > 0 else 0


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def object_report(key, asset, hour, status, **extra):
    return {"key": key, "asset": asset, "hour": hour, "status": status, **extra}


def atomic_text(path, value):
    with tempfile.NamedTemporaryFile(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, mode="w", encoding="utf-8", delete=False) as output:
        output.write(value)
        output.flush()
        temporary = Path(output.name)
    temporary.replace(path)


if __name__ == "__main__":
    main()
