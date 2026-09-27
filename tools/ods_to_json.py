#!/usr/bin/env python3
"""Convert minecraft_survival_alerts.ods -> data/game-data.json.

The spreadsheet is the single source of truth; the widget consumes only the generated JSON.
Also validates: every item references a known effect + existing asset, every item has a reward row.

Usage: python3 tools/ods_to_json.py [--check]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ods_update import read_ods  # shared reader

OUT_PATH = 'data/game-data.json'

ROMAN = {'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5}
ASSET_ROOT = 'assets'


def num(s, default=None):
    s = (s or '').strip()
    if s == '':
        return default
    try:
        return int(s)
    except ValueError:
        try:
            return float(s)
        except ValueError:
            return default


def bool_str(s):
    return (s or '').strip().lower() in ('yes', 'true', '1')


def parse_effect_token(tok):
    """'regeneration_II' -> ('regeneration', 2); 'hunger_I' -> ('hunger', 1)."""
    tok = tok.strip()
    for suf, lvl in ROMAN.items():
        if tok.endswith('_' + suf):
            return tok[: -(len(suf) + 1)], lvl
    return tok, 1


def parse_list_cell(cell):
    """'[a, b, c]' -> ['a','b','c'] (no brackets -> [])."""
    cell = (cell or '').strip()
    if cell in ('', '[]', 'null'):
        return []
    inner = cell.strip('[]')
    return [t.strip() for t in inner.split(',') if t.strip()]


def parse_stew_pool(cell):
    """'[poison_I:11000, ...]' -> [{id, level, duration_ms}, ...]"""
    out = []
    for tok in parse_list_cell(cell):
        if ':' not in tok:
            continue
        effect, dur = tok.rsplit(':', 1)
        eid, lvl = parse_effect_token(effect)
        out.append({'id': eid, 'level': lvl, 'duration_ms': num(dur, 0)})
    return out


def convert_items(rows):
    hdr = rows[0]
    col = {name: i for i, name in enumerate(hdr)}
    items = []
    for r in rows[1:]:
        fid = r[col['food_id']].strip()
        if not fid:
            continue
        effects_raw = parse_list_cell(r[col['status_effects']])
        times_raw = parse_list_cell(r[col['status_effect_times']])
        effects, stew_pool, clears, teleport = [], [], None, False
        for i, tok in enumerate(effects_raw):
            dur = num(times_raw[i]) if i < len(times_raw) else 0
            if tok == 'RANDOM_ONE_OF':
                stew_pool = parse_stew_pool(r[col['status_effect_times']])
            elif tok == 'clear_all_status':
                clears = 'all'
            elif tok == 'clear_poison':
                clears = 'poison'
            elif tok == 'chorus_teleport':
                teleport = True
            else:
                eid, lvl = parse_effect_token(tok)
                effects.append({'id': eid, 'level': lvl, 'duration_ms': dur or 0,
                                'chance_pct': num(r[col['effect_chance_pct']], 100)})
        asset = r[col['asset_file']].strip()
        asset_missing = not asset.endswith('.png')
        if not asset_missing:
            asset_path = f'{ASSET_ROOT}/food/{asset}'
            if not os.path.exists(asset_path):
                print(f'  WARN asset not found on disk: {asset_path} ({fid})')
        item = {
            'id': fid,
            'display_name': r[col['display_name']],
            'asset': asset if not asset_missing else None,
            'asset_missing': asset_missing,
            'hunger': num(r[col['hunger_value']]),
            'saturation_modifier': num(r[col['saturation_modifier']]),
            'saturation': num(r[col['saturation_value']]),
            'consume_time_ms': int(round(num(r[col['consume_time_seconds']], 1.6) * 1000)),
            'can_always_eat': bool_str(r[col['can_always_eat']]),
            'stack_size': num(r[col['stack_size']], 64),
            'eat_when_hp_below': num(r[col['eat_when_hp_below']]),
            'sound_profile': (r[col['sound_profile']].strip() or 'eat') if 'sound_profile' in col else 'eat',
            'effects': effects,
            'stew_pool': stew_pool,
            'clears_effects': clears,
            'teleport_fx': teleport,
            'points_cost': num(r[col['suggested_points_cost']]),
            'cooldown_s': num(r[col['suggested_cooldown_seconds']]),
            'notes': r[col['notes']],
        }
        items.append(item)
    return items


def convert_effects(rows):
    hdr = rows[0]
    col = {name: i for i, name in enumerate(hdr)}
    effects = {}
    for r in rows[1:]:
        eid = r[col['status_effect_id']].strip()
        if not eid:
            continue
        icon = r[col['icon_asset']].strip()
        icon_missing = not icon.endswith('.png')
        params = {}
        for key in ('interval_ticks_formula', 'interval_i_ms', 'hp_change_per_interval',
                    'can_kill', 'exhaustion_per_tick', 'damage_multiplier',
                    'absorption_hp_per_level', 'instant_hp_formula', 'visual_overlay'):
            if key in col and r[col[key]].strip():
                params[key] = r[col[key]].strip()
        effects[eid] = {
            'id': eid,
            'display_name': r[col['display_name']],
            'type': r[col['type']],
            'hud_row': r[col['hud_row']],
            'icon': icon if not icon_missing else None,
            'icon_missing': icon_missing,
            'sim_behavior': r[col['sim_behavior']],
            'params': params,
        }
    return effects


def convert_config(rows):
    config = {}
    for r in rows[1:]:
        key = r[0].strip()
        if not key:
            continue
        val = r[1].strip() if len(r) > 1 else ''
        # typed cast for pure numerics, keep strings otherwise
        n = num(val)
        config[key] = n if n is not None and str(n) == val else val
    return config


def convert_rewards(rows, items):
    hdr = rows[0]
    col = {name: i for i, name in enumerate(hdr)}
    by_food = {i['id']: i for i in items}
    rewards = []
    for r in rows[1:]:
        fid = r[col['food_id']].strip()
        if not fid:
            continue
        rewards.append({
            'food_id': fid,
            'title': r[col['reward_title_suggested']],
            'cost': num(r[col['cost']]),
            'cooldown_s': num(r[col['cooldown_seconds']]),
            'max_per_user_per_stream': num(r[col['max_per_user_per_stream']], 0),
            'enabled': bool_str(r[col['enabled']]) if 'enabled' in col else True,
        })
    # cross-checks
    for rew in rewards:
        if rew['food_id'] not in by_food:
            print(f"  WARN reward references unknown item: {rew['food_id']}")
    for i in items:
        if i['id'] not in {r['food_id'] for r in rewards}:
            print(f"  WARN item without reward row: {i['id']}")
        for eff in i['effects']:
            pass  # validated below with effects table
    return rewards


def main():
    sheets = read_ods('minecraft_survival_alerts.ods')
    items = convert_items(sheets['items'])
    data = {
        'items': items,
        'effects': convert_effects(sheets['status_effects']),
        'config': convert_config(sheets['simulation_config']),
        'rewards': convert_rewards(sheets['channel_points'], items),
    }
    # effects cross-check (items -> effects sheet)
    effect_ids = set(data['effects'])
    for i in data['items']:
        for eff in i['effects']:
            if eff['id'] not in effect_ids:
                print(f"  WARN item {i['id']} references unknown effect: {eff['id']}")
        for tok in i['stew_pool']:
            if tok['id'] not in effect_ids:
                print(f"  WARN stew pool of {i['id']} references unknown effect: {tok['id']}")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump(data, f, indent=2, sort_keys=False)
        f.write('\n')

    # OBS browser sources load via file:// where fetch() is CORS-blocked;
    # emit a plain <script> payload alongside the canonical JSON.
    os.makedirs('src/js', exist_ok=True)
    with open('src/js/gamedata.js', 'w') as f:
        f.write('// GENERATED by tools/ods_to_json.py — do not hand-edit.\n')
        f.write('window.GAME_DATA = ')
        f.write(json.dumps(data, separators=(',', ':')))
        f.write(';\n')

    print(f'OK wrote {OUT_PATH}: '
          f'{len(data["items"])} items, {len(data["effects"])} effects, '
          f'{len(data["config"])} config keys, {len(data["rewards"])} rewards')
    missing_assets = sum(1 for i in data['items'] if i['asset_missing'])
    missing_icons = sum(1 for e in data['effects'].values() if e['icon_missing'])
    print(f'     asset gaps: {missing_assets} item sprites, {missing_icons} effect icons '
          f'(see implementation-plan.md asset task)')


if __name__ == '__main__':
    main()
