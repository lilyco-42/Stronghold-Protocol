#!/usr/bin/env python3
"""Fetch the AssetBundles extract.py needs straight from the official CDN (no game install).

The CN client's bundles are published on ak.hycdn.cn under a per-release directory; the same files the installed
client downloads on first launch. A bundle is addressed by its path inside the client's AB root with '/' replaced
by '_' and '.ab' replaced by '.dat' (arts/maps/map_autochess/res.ab → arts_maps_map_autochess_res.dat), and the
server answers with a **ZIP whose single entry is the real .ab at its original path** — so unzipping into the output
directory rebuilds exactly the tree extract.py's --game expects.

The bundle list is read from extract.py's own job table (--print-jobs), so it cannot drift from what is extracted.

Usage:
  python3 tools/local-extract/fetch-cdn.py [--out <AB root>] [--version <cdn dir>] [--list]
  python3 tools/local-extract/extract.py --game <that AB root>

Two things this cannot get (both optional, extract.py skips them with a warning):
  - the enemy art bundles (refs/arts/enm_art_<n>.ab, ENEMY_SPINES): named by an internal index, not by path, so the
    flattened URL is not derivable — 灼热 / 炽焰源石虫 keep the web alias unless extracted from a real install
  - shaders/*.ab (material shader *names* only; the root [uc]shaders.ab, which holds the particle shaders the map
    effects need, is fetched)

The version directory is the Android assets dir of the current client release; the community mirror
github.com/555me/hycdn lists them (its `ak/` folder), and a game update adds a new one. Everything downloaded is
(c) Hypergryph; for private, non-commercial fan use only.
"""
import argparse
import json
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BASE = 'https://ak.hycdn.cn/assetbundle/official/Android/assets'
VERSION = '26-09-22-07-47-20_6c71fa'
# the root shader bundle (SHADER_DEPS_ROOT in extract.py) is not a job output, so it is not in --print-jobs
EXTRA = ['[uc]shaders.ab']
# a missing bundle answers 200 with this body, so the status code proves nothing — the size decides
STUB_BYTES = 12


def cdn_name(rel):
    """Bundle path inside the client's AB root → the flattened .dat name on the CDN."""
    return rel.replace('/', '_').removesuffix('.ab') + '.dat'


def job_bundles():
    """Every bundle path extract.py reads, from its own job table (no dependencies needed)."""
    out = subprocess.run([sys.executable, str(HERE / 'extract.py'), '--print-jobs'],
                         capture_output=True, text=True, cwd=ROOT, check=True).stdout
    jobs = json.loads(out)['jobs']
    rels = sorted({j['bundle'] for j in jobs})
    return rels + [e for e in EXTRA if e not in rels]


def fetch(name, version, dat_dir):
    url = f'{BASE}/{version}/{name}'
    dest = dat_dir / name
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=120) as r:
        data = r.read()
    dest.write_bytes(data)
    return len(data)


def main():
    ap = argparse.ArgumentParser(description='Download and unpack the official AssetBundles extract.py needs.')
    ap.add_argument('--out', default=str(ROOT.parent / 'Stronghold-AB-cdn'), metavar='DIR',
                    help='AB root to rebuild (default: <repo 上一级>/Stronghold-AB-cdn)')
    ap.add_argument('--version', default=VERSION, help=f'CDN asset directory (current: {VERSION})')
    ap.add_argument('--force', action='store_true', help='re-download bundles already unpacked under --out')
    ap.add_argument('--list', action='store_true', help='print the bundle paths and exit (no network)')
    args = ap.parse_args()

    rels = job_bundles()
    if args.list:
        for rel in rels:
            print(rel)
        return 0

    out = Path(args.out)
    dat_dir = out / '.dat'
    dat_dir.mkdir(parents=True, exist_ok=True)
    got, have, missing, failed = 0, 0, 0, 0
    for rel in rels:
        target = out / rel
        if target.exists() and not args.force:
            have += 1
            print(f'  have     {rel}  ({target.stat().st_size:,} B)')
            continue
        name = cdn_name(rel)
        try:
            size = fetch(name, args.version, dat_dir)
        except Exception as e:
            failed += 1
            print(f'  FAILED   {rel}  {type(e).__name__}: {e}', file=sys.stderr)
            continue
        if size <= STUB_BYTES:
            missing += 1
            print(f'  missing  {rel}  (CDN answered {size} B — not published under {args.version})', file=sys.stderr)
            continue
        with zipfile.ZipFile(dat_dir / name) as z:
            z.extractall(out)
        got += 1
        print(f'  got      {rel}  ({size:,} B .dat → {(target.stat().st_size if target.exists() else 0):,} B .ab)')

    total = sum(p.stat().st_size for p in out.rglob('*.ab'))
    print(f'\n{got} downloaded, {have} already present, {missing} missing, {failed} failed → {out} '
          f'({total / 1048576:.1f} MB of .ab)')
    if got + have:
        print(f'next:  python3 tools/local-extract/extract.py --game "{out}"')
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
