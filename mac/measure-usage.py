#!/usr/bin/env python3
"""Bounded macOS CPU/memory snapshot; Python standard library only."""

import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


class RusageInfoV0(ctypes.Structure):
    # Darwin sys/resource.h, RUSAGE_INFO_V0. CPU counters are nanoseconds.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups",
            "pageins", "wired_size", "resident_size", "phys_footprint",
            "proc_start_abstime", "proc_exit_abstime",
        )
    ]


def process_table():
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,comm="],
        check=True, capture_output=True, text=True, timeout=5,
    )
    rows = {}
    for line in result.stdout.splitlines():
        pid, parent, command = line.strip().split(None, 2)
        rows[int(pid)] = {"parent": int(parent), "command": command}
    return rows


def app_processes(rows, root, responsible):
    # XPC helpers have launchd as their parent. macOS responsibility, not the
    # WebKit executable name, associates them with the app that launched them.
    selected = {root}
    for pid in rows:
        if pid != os.getpid() and responsible(pid) == root:
            selected.add(pid)
    while True:
        children = {pid for pid, row in rows.items()
                    if row["parent"] in selected and pid != os.getpid()}
        if children <= selected:
            return selected
        selected |= children


def cpu_percent(before, after, elapsed):
    if before.proc_start_abstime != after.proc_start_abstime:
        raise RuntimeError("A process restarted during measurement; rerun the script.")
    delta = after.user_time + after.system_time - before.user_time - before.system_time
    if delta < 0:
        raise RuntimeError("CPU counters moved backwards; rerun the script.")
    return delta / 1_000_000_000 / elapsed * 100


def category_sum(categories, field):
    return sum(value[field] for name, value in categories.items() if name != "total")


def memory_report(raw, pids):
    if raw.get("errors"):
        raise RuntimeError(f"Incomplete footprint snapshot: {raw['errors']}")
    if raw.get("bytes per unit") != 1:
        raise RuntimeError("Expected footprint output in bytes.")
    if {p["pid"] for p in raw["processes"]} != set(pids):
        raise RuntimeError("The memory snapshot missed a process; rerun the script.")
    processes = {}
    for proc in raw["processes"]:
        processes[proc["pid"]] = {
            "footprint_bytes": proc["footprint"],
            # footprint(1): Dirty includes its parenthesized Swapped subset.
            "private_dirty_resident_bytes": (
                category_sum(proc["categories"], "dirty")
                - category_sum(proc["categories"], "swapped")
            ),
            "private_swapped_bytes": category_sum(proc["categories"], "swapped"),
        }
    # Use the tool's group total, not a sum of per-process RSS or shared regions.
    # Per-process categories exclude its separately listed shared categories.
    return processes, {
        "footprint_bytes": raw["total footprint"],
        "private_dirty_resident_bytes": sum(
            p["private_dirty_resident_bytes"] for p in processes.values()),
        "swapped_bytes": raw["summary"]["total"]["swapped"],
        "reclaimable_bytes": raw["summary"]["total"]["reclaimable"],
    }


def measure(pid, seconds):
    system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    try:
        # Private macOS API: fail explicitly if unavailable; never include every
        # WebKit process as a fallback (that would count Safari and other apps).
        responsible = system.responsibility_get_pid_responsible_for_pid
    except AttributeError as exc:
        raise RuntimeError("This macOS version does not expose process responsibility.") from exc
    responsible.argtypes = [ctypes.c_int]
    responsible.restype = ctypes.c_int
    libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    libproc.proc_pid_rusage.restype = ctypes.c_int

    def usage(target):
        info = RusageInfoV0()
        if libproc.proc_pid_rusage(target, 0, ctypes.byref(info)) != 0:
            raise OSError(ctypes.get_errno(), f"Cannot read process {target}")
        return info

    rows = process_table()
    if pid is None:
        roots = [p for p, row in rows.items() if Path(row["command"]).name == "Tucode"]
        if len(roots) != 1:
            raise RuntimeError(f"Expected one running Tucode, found {roots}; launch it or use --pid.")
        pid = roots[0]
    if pid not in rows:
        raise RuntimeError(f"PID {pid} is not running.")
    if responsible(pid) != pid:
        raise RuntimeError(
            "The app does not have its own macOS responsibility identity. "
            "Launch the .app with Finder or open, then rerun to attribute XPC helpers correctly.")
    pids = sorted(app_processes(rows, pid, responsible))
    before = {p: usage(p) for p in pids}
    started = time.monotonic()
    time.sleep(seconds)  # One idle wait, not a polling or profiling loop.
    after = {p: usage(p) for p in pids}
    elapsed = time.monotonic() - started
    current = process_table()
    if set(pids) != app_processes(current, pid, responsible):
        raise RuntimeError("App processes changed during measurement; rerun once the app settles.")
    cpu = {p: cpu_percent(before[p], after[p], elapsed) for p in pids}

    # Collect memory after CPU so footprint's inspection does not affect the
    # measured CPU interval. The temporary raw snapshot is removed automatically.
    with tempfile.TemporaryDirectory(prefix="tucode-usage-") as folder:
        output = Path(folder) / "footprint.json"
        command = ["/usr/bin/footprint", "--swapped", "-f", "bytes", "-j", str(output)]
        for p in pids:
            command.extend(["-p", str(p)])
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.PIPE, text=True, timeout=15)
        raw = json.loads(output.read_text())
    for p in pids:
        if usage(p).proc_start_abstime != before[p].proc_start_abstime:
            raise RuntimeError("A process restarted during the memory snapshot; rerun the script.")
    memory, totals = memory_report(raw, pids)
    totals["cpu_percent"] = sum(cpu.values())
    return {
        "measured_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "cpu_interval_seconds": elapsed,
        "root_pid": pid,
        "excluded_webkit_processes": sum(
            "com.apple.WebKit." in row["command"] and p not in pids
            for p, row in rows.items()),
        "processes": [{"pid": p, "command": rows[p]["command"],
                       "cpu_percent": cpu[p], **memory[p]} for p in pids],
        "totals": totals,
        "warnings": raw.get("warnings", []),
        "notes": [
            "CPU: 100% is one logical core; only processes present throughout the interval.",
            "Footprint: macOS group accounting, including compressed/swapped memory; excludes clean shared framework pages.",
            "Private dirty: resident non-reclaimable memory excluding shared regions; not all resident memory.",
            "Reclaimable memory is separate from footprint; do not add swapped memory to footprint again.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, help="app PID (default: the single running Tucode)")
    parser.add_argument("--seconds", type=float, default=2, help="CPU interval, 1–10 seconds (default: 2)")
    parser.add_argument("--json", type=Path, help="also save the report as JSON")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This script requires macOS.")
    if not 1 <= args.seconds <= 10:
        parser.error("--seconds must be between 1 and 10")
    try:
        report = measure(args.pid, args.seconds)
        if args.json:
            args.json.write_text(json.dumps(report, indent=2) + "\n")
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        print(f"Measurement failed: {detail}", file=sys.stderr)
        return 1

    mib = 1024 * 1024
    print(f"{report['measured_at']} | CPU interval: {report['cpu_interval_seconds']:.2f}s")
    names = [Path(p["command"]).name.removeprefix("com.apple.") for p in report["processes"]]
    width = max(24, *(len(name) for name in names))
    print(f"{'PID':>7}  {'Process':<{width}} {'CPU %':>8} {'Footprint MiB':>14} {'Private dirty MiB':>21}")
    for proc in report["processes"]:
        name = Path(proc["command"]).name.removeprefix("com.apple.")
        print(f"{proc['pid']:7}  {name:<{width}} {proc['cpu_percent']:8.2f} "
              f"{proc['footprint_bytes'] / mib:14.2f} {proc['private_dirty_resident_bytes'] / mib:21.2f}")
    totals = report["totals"]
    print(f"{'TOTAL':>7}  {'':{width}} {totals['cpu_percent']:8.2f} "
          f"{totals['footprint_bytes'] / mib:14.2f} {totals['private_dirty_resident_bytes'] / mib:21.2f}")
    print(f"Compressed/swapped (included): {totals['swapped_bytes'] / mib:.2f} MiB")
    print(f"Reclaimable (separate): {totals['reclaimable_bytes'] / mib:.2f} MiB")
    print(f"Other apps' WebKit processes excluded: {report['excluded_webkit_processes']}")
    for note in report["notes"]:
        print(note)
    for warning in report["warnings"]:
        print(f"Warning: {warning}")
    if args.json:
        print(f"Saved: {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
