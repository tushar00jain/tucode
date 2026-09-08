"""Accounting regressions; no live sampling or additional dependencies."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("usage", Path(__file__).with_name("measure-usage.py"))
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


class UsageTests(unittest.TestCase):
    def test_xpc_ownership_excludes_safari_but_includes_app_descendants(self):
        rows = {
            10: {"parent": 1}, 11: {"parent": 1},  # app and its launchd-owned XPC
            12: {"parent": 10}, 13: {"parent": 12},  # nested app children
            20: {"parent": 1}, 21: {"parent": 1},  # Safari and its XPC
        }
        owners = {10: 10, 11: 10, 20: 20, 21: 20}
        self.assertEqual(usage.app_processes(rows, 10, lambda p: owners.get(p, -1)),
                         {10, 11, 12, 13})

    def test_compression_and_shared_memory_are_not_double_counted(self):
        categories = {"malloc": {"dirty": 100, "swapped": 30},
                      "total": {"dirty": 100, "swapped": 30}}
        raw = {
            "bytes per unit": 1, "errors": [],
            "processes": [{"pid": p, "footprint": 140, "categories": categories}
                          for p in (10, 11)],
            # Shared dirty pages are accounted once in the group summary.
            "total footprint": 240,
            "summary": {"total": {"swapped": 60, "reclaimable": 400}},
        }
        processes, totals = usage.memory_report(raw, {10, 11})
        self.assertEqual(processes[10]["private_dirty_resident_bytes"], 70)
        self.assertEqual(totals["private_dirty_resident_bytes"], 140)
        self.assertEqual(totals["footprint_bytes"], 240)
        self.assertEqual(totals["swapped_bytes"], 60)
        with self.assertRaises(RuntimeError):
            usage.memory_report(raw, {10, 11, 12})

    def test_cpu_uses_interval_and_one_core_convention(self):
        before, after = usage.RusageInfoV0(), usage.RusageInfoV0()
        before.user_time = 10_000_000_000
        after.user_time = 12_000_000_000
        after.system_time = 1_000_000_000
        self.assertEqual(usage.cpu_percent(before, after, 2), 150)
        after.proc_start_abstime = 1
        with self.assertRaises(RuntimeError):
            usage.cpu_percent(before, after, 2)


if __name__ == "__main__":
    unittest.main()
