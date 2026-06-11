#!/usr/bin/env python3
"""Aggregate top -H by (mapped process role, thread name)."""
import re, sys, collections

tidmap = {}
for line in open('/tmp/tidmap.out'):
    parts = line.split(None, 3)
    if len(parts) < 4: continue
    pid, tid, comm, args = parts
    role = 'browser'
    if '--type=renderer' in args: role = 'renderer'
    elif '--type=gpu-process' in args: role = 'gpu'
    elif '--type=utility' in args: role = 'utility'
    elif '--type=zygote' in args: role = 'zygote'
    tidmap[tid] = role

txt = open('/tmp/top3.out').read()
blocks = txt.split('top - ')
n = len(blocks) - 2
agg = collections.defaultdict(float)
mx = collections.defaultdict(float)
for b in blocks[2:]:
    for line in b.splitlines():
        m = re.match(r'\s*(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S\s+([\d.]+)\s+[\d.]+\s+\S+\s+(.+)', line)
        if not m: continue
        tid, cpu, name = m.group(1), float(m.group(2)), m.group(3).strip()
        if cpu < 0.5: continue
        role = tidmap.get(tid, '?')
        key = f'{role:9s} {name[:24]}'
        agg[key] += cpu
        mx[key] = max(mx[key], cpu)
print(f'iterations: {n}')
for k in sorted(agg, key=lambda k: -agg[k])[:20]:
    print(f'{agg[k]/n:6.1f}%avg {mx[k]:6.1f}%max  {k}')
