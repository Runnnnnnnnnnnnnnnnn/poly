import argparse
import json
import os
from pathlib import Path

import eth_account


def main():
    parser = argparse.ArgumentParser(description="Provision a dedicated Hyperliquid testnet API wallet")
    parser.add_argument(
        "--key-file",
        default=str(Path.home() / ".polymarket-watch" / "secrets" / "hyperliquid-testnet-api-wallet.key"),
    )
    args = parser.parse_args()
    key_path = Path(args.key_file).expanduser().resolve()
    key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(key_path.parent, 0o700)

    created = False
    if key_path.exists():
        mode = key_path.stat().st_mode & 0o777
        if mode & 0o077:
            raise ValueError(f"API wallet key file permissions must be 600, found {mode:o}")
        secret_key = key_path.read_text(encoding="utf-8").strip()
        wallet = eth_account.Account.from_key(secret_key)
    else:
        wallet = eth_account.Account.create()
        secret_key = wallet.key.hex()
        descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(f"0x{secret_key}\n")
            output.flush()
            os.fsync(output.fileno())
        created = True

    print(json.dumps({
        "created": created,
        "apiWalletAddress": wallet.address,
        "keyFile": str(key_path),
        "permissions": oct(key_path.stat().st_mode & 0o777),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
