from hyperliquid_testnet_safety import clear_dead_man_switch_if_flat, schedule_dead_man_switch


class FakeExchange:
    def __init__(self, status="ok"):
        self.status = status
        self.calls = []

    def schedule_cancel(self, value):
        self.calls.append(value)
        return {"status": self.status}


class FakeInfo:
    def __init__(self, snapshots):
        self.snapshots = iter(snapshots)

    def open_orders(self, _account_address):
        return next(self.snapshots)


exchange = FakeExchange()
assert schedule_dead_man_switch(exchange, 160_000, now_ms=100_000) == 160_000
assert exchange.calls == [160_000]

for deadline in (104_999, 400_001):
    try:
        schedule_dead_man_switch(exchange, deadline, now_ms=100_000)
        raise AssertionError("invalid dead-man switch deadline was accepted")
    except ValueError:
        pass

try:
    schedule_dead_man_switch(FakeExchange(status="error"), 160_000, now_ms=100_000)
    raise AssertionError("failed dead-man switch scheduling was accepted")
except RuntimeError:
    pass

sleeps = []
cleared = FakeExchange()
assert clear_dead_man_switch_if_flat(FakeInfo([[{}], []]), cleared, "0xabc", sleeps.append) is True
assert sleeps == [0.5]
assert cleared.calls == [None]

not_cleared = FakeExchange()
assert clear_dead_man_switch_if_flat(
    FakeInfo([[{}], [{}], [{}]]),
    not_cleared,
    "0xabc",
    lambda _seconds: None,
) is False
assert not_cleared.calls == []

print("dead-man switch connector tests passed")
