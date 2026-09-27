#!/usr/bin/env python3
"""Update minecraft_survival_alerts.ods — add engine-critical metadata missing from the sheet.

All values verified against minecraft.wiki (Java Edition 1.21.x) on 2025 during research:
  - Poison / Wither / Regeneration interval formulas (max(1, base>>amp): 25 / 40 / 50 ticks)
  - Resistance damage multiplier (1 - 0.2*lvl, NOT starvation)
  - Absorption 4 HP per level, depletes first, non-regenerable
  - Instant Health +4*2^amp / Instant Damage -6*2^amp
  - Hunger effect exhaustion 0.005 * level per tick
  - Suspicious stew blindness 11 s in Java (7 s was Bedrock) — fixed

Idempotent: safe to re-run (all edits check before applying).
Creates a timestamped .bak before writing.
"""
import re
import sys
import shutil
import zipfile
import datetime
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

ODS_PATH = 'minecraft_survival_alerts.ods'
TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
OFF_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'

# ---------------------------------------------------------------- read / write

def read_ods(path):
    """ODS -> {sheet_name: [[cell strings]]} (trailing empties stripped, rows padded)."""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('content.xml'))
    ss = root.find(f'{{{OFF_NS}}}body').find(f'{{{OFF_NS}}}spreadsheet')
    sheets = {}
    for t in ss.findall(f'{{{TABLE_NS}}}table'):
        name = t.get(f'{{{TABLE_NS}}}name')
        rows = []
        for row in t.findall(f'{{{TABLE_NS}}}table-row'):
            if int(row.get(f'{{{TABLE_NS}}}number-rows-repeated', '1')) > 100:
                continue  # sheet-edge filler
            cells = []
            for c in row.findall(f'{{{TABLE_NS}}}table-cell'):
                rep = int(c.get(f'{{{TABLE_NS}}}number-columns-repeated', '1'))
                if rep > 4096:
                    continue  # sheet-edge filler
                vt = c.get(f'{{{OFF_NS}}}value-type')
                if vt in ('float', 'percentage', 'currency'):
                    val = c.get(f'{{{OFF_NS}}}value') or ''
                else:
                    val = ''.join(p.text or '' for p in c.iter(f'{{{TEXT_NS}}}p'))
                cells.extend([val] * rep)
            while cells and cells[-1] == '':
                cells.pop()
            if cells:
                rows.append(cells)
        if rows:
            width = max(len(r) for r in rows)
            for r in rows:
                r.extend([''] * (width - len(r)))
        sheets[name] = rows
    return sheets

NUM_RE = re.compile(r'^-?\d+(?:\.\d+)?$')

def cell_xml(v):
    if v is None or v == '':
        return '<table:table-cell/>'
    if NUM_RE.match(v):
        return (f'<table:table-cell office:value-type="float" office:value="{escape(v)}">'
                f'<text:p>{escape(v)}</text:p></table:table-cell>')
    return f'<table:table-cell office:value-type="string"><text:p>{escape(v)}</text:p></table:table-cell>'

def write_ods(path, sheets):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<office:document-content'
        ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
        ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
        ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
        ' office:version="1.2">',
        '<office:body><office:spreadsheet>',
    ]
    for name, rows in sheets.items():
        cols = max(len(r) for r in rows) if rows else 1
        parts.append(f'<table:table table:name="{escape(name)}">')
        parts.append(f'<table:table-column table:number-columns-repeated="{cols}"/>')
        for r in rows:
            parts.append('<table:table-row>')
            parts.extend(cell_xml(v) for v in r)
            parts.append('</table:table-row>')
        parts.append('</table:table>')
    parts.append('</office:spreadsheet></office:body></office:document-content>')
    content = ''.join(parts)

    styles = ('<?xml version="1.0" encoding="UTF-8"?>'
              '<office:document-styles'
              ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
              ' office:version="1.2"><office:styles/></office:document-styles>')
    manifest = ('<?xml version="1.0" encoding="UTF-8"?>'
                '<manifest:manifest'
                ' xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"'
                ' manifest:version="1.2">'
                '<manifest:file-entry manifest:full-path="/" manifest:version="1.2"'
                ' manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>'
                '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
                '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>'
                '</manifest:manifest>')

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        # mimetype MUST be first entry and STORED
        zi = zipfile.ZipInfo('mimetype')
        z.writestr(zi, 'application/vnd.oasis.opendocument.spreadsheet',
                   compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/manifest.xml', manifest)
        z.writestr('content.xml', content)
        z.writestr('styles.xml', styles)

# ---------------------------------------------------------------- edits

SOUND_PROFILE = {
    'bucket_milk': 'drink',
    'honey_bottle': 'drink',
    'chorus_fruit': 'eat_teleport_fx',
}

def edit_items(rows):
    hdr = rows[0]
    changed = []
    # new column: sound_profile (eat / drink / eat_teleport_fx)
    if 'sound_profile' not in hdr:
        hdr.append('sound_profile')
        for r in rows[1:]:
            r.append(SOUND_PROFILE.get(r[0], 'eat'))
        changed.append("items: +column sound_profile")
    i_id = hdr.index('food_id')
    i_asset = hdr.index('asset_file')
    i_times = hdr.index('status_effect_times')
    i_notes = hdr.index('notes')
    for r in rows[1:]:
        fid = r[i_id]
        if fid == 'apple_golden_enhanced' and not r[i_asset].endswith('.png'):
            r[i_asset] = 'apple_golden.png'
            r[i_notes] += ' | render with purple enchanted shimmer (CSS glow overlay)'
            changed.append("items: apple_golden_enhanced asset -> apple_golden.png (+CSS shimmer)")
        if fid in ('cake', 'cake_slice') and 'extract' not in r[i_asset]:
            r[i_asset] = '(MISSING: extract textures/item/cake.png from client jar; slice = wedge crop)'
            changed.append(f"items: {fid} asset -> extraction hint")
        if fid == 'suspicious_stew' and 'blindness_I:11000' not in r[i_times]:
            r[i_times] = r[i_times].replace('blindness_I:7000', 'blindness_I:11000')
            r[i_notes] += ' | blindness FIXED to 11000ms — Java is 11s (7s was Bedrock)'
            changed.append("items: suspicious_stew blindness 7000 -> 11000 ms (Java)")
    return changed

# Numeric/formula params for the effect engine (columns appended to status_effects).
EFFECT_COLS = [
    'interval_ticks_formula',   # DoT/heal interval per amplifier, in game ticks
    'interval_i_ms',            # level-I interval in ms, for quick reading
    'hp_change_per_interval',   # +1 heal / -1 damage per interval
    'can_kill',                 # can the effect bring HP to 0?
    'exhaustion_per_tick',      # hunger effect pump
    'damage_multiplier',        # resistance
    'absorption_hp_per_level',  # absorption
    'instant_hp_formula',       # instant health / damage
    'visual_overlay',            # widget cosmetic treatment
]

EFFECT_PARAMS = {
    'regeneration':  dict(interval_ticks_formula='max(1, 50>>amp)', interval_i_ms='2500',
                          hp_change_per_interval='+1', can_kill='n/a (heal)'),
    'poison':        dict(interval_ticks_formula='max(1, 25>>amp)', interval_i_ms='1250',
                          hp_change_per_interval='-1', can_kill='no (stops at 1 HP)'),
    'wither':        dict(interval_ticks_formula='max(1, 40>>amp)', interval_i_ms='2000',
                          hp_change_per_interval='-1', can_kill='yes'),
    'hunger':        dict(exhaustion_per_tick='0.005*(amp+1)'),
    'resistance':    dict(damage_multiplier='max(0, 1-0.2*lvl)'),
    'absorption':    dict(absorption_hp_per_level='4'),
    'instant_health': dict(instant_hp_formula='+4*2^amp'),
    'instant_damage': dict(instant_hp_formula='-6*2^amp'),
    'blindness':     dict(visual_overlay='dark_vignette'),
    'nausea':        dict(visual_overlay='hud_sway'),
    'darkness':      dict(visual_overlay='pulsing_dark_vignette'),
    'night_vision':  dict(visual_overlay='none (icon only; widget is transparent)'),
    'saturation':    dict(instant_hp_formula='n/a (hunger +1*lvl, saturation +2*lvl, instant)'),
}

def edit_status_effects(rows):
    hdr = rows[0]
    changed = []
    if 'interval_ticks_formula' not in hdr:
        hdr.extend(EFFECT_COLS)
        for r in rows[1:]:
            params = EFFECT_PARAMS.get(r[0], {})
            r.extend([params.get(c, '') for c in EFFECT_COLS])
        changed.append('status_effects: +9 numeric/formula param columns')
    i_id = hdr.index('status_effect_id')
    i_icon = hdr.index('icon_asset')
    for r in rows[1:]:
        eid = r[i_id]
        # fill param columns for rows that were previously empty (idempotent backfill)
        params = EFFECT_PARAMS.get(eid, {})
        for col in EFFECT_COLS:
            if col in hdr and not r[hdr.index(col)] and col in params:
                r[hdr.index(col)] = params[col]
        if r[i_icon].startswith('(MISSING'):
            r[i_icon] = f'(MISSING: extract textures/mob_effect/{eid}.png from client jar)'
    # note the wither damage-immunity cap where the formula lives
    i_int = hdr.index('interval_ticks_formula') if 'interval_ticks_formula' in hdr else None
    return changed

NEW_CONFIG = [
    # key, value, note
    ('engine.initial_health', '20', 'Starting HP on first load / respawn'),
    ('engine.initial_hunger', '20', 'Starting hunger on first load / respawn'),
    ('engine.effect_stacking_rule', 'duration: longer wins; level: higher wins',
     'Vanilla: re-apply never downgrades; no additive stacking'),
    ('effects.blink_threshold_s', '10', 'HUD icons blink when remaining < this'),
    ('effects.icon_size_px', '18', 'Vanilla effect icon sprite size, rendered x gui_scale'),
    ('eat.bite_interval_ms', '200', 'One bite per 4 game ticks: chew sound + particles'),
    ('eat.chew_anim_hz', '4', 'Item sprite wobble frequency while eating'),
    ('eat.particles_per_bite', '3', 'Crumb particles per bite'),
    ('ui.gui_scale', '3', '1 GUI px = scale screen px; URL ?scale= overrides'),
    ('ui.damage_flash_ms', '500', 'White heart overlay flash on HP loss'),
    ('ui.low_hp_jitter_hp', '4', 'Hearts jitter at HP <= 4 (vanilla low-health shake)'),
    ('ui.absorption_hearts_wrap', 'true', 'Yellow hearts wrap to 2nd row past 10 hearts'),
    ('ui.effect_sort', 'soonest_expire_leftmost', 'Vanilla HUD effect icon order'),
    ('sound.volume', '0.8', 'Master volume for all SFX'),
    ('sound.eat_pool', 'eat1.ogg,eat2.ogg,eat3.ogg', 'Randomized per bite'),
    ('sound.drink_pool', 'drink1.ogg,drink2.ogg,drink3.ogg', 'Milk / honey bottle'),
    ('death.clear_effects', 'true', 'Death clears all status effects (vanilla)'),
    ('chorus.particle_burst', '30', 'Purple particles on teleport'),
    ('chorus.hud_shake_ms', '500', 'Cosmetic HUD shake on teleport'),
    ('persistence.localstorage_key', 'mc_hud_state_v1', 'Snapshot key; OBS CEF persists per source'),
    ('ws.default_host', '127.0.0.1', 'Streamer.bot WebSocket server'),
    ('ws.default_port', '8080', 'Default SB port; URL ?port= overrides'),
    ('refund.action_name', 'MC Refund', 'SB action: Update Redemption Status -> Cancel'),
    ('fulfill.action_name', 'MC Fulfill', 'SB action: Update Redemption Status -> Fulfilled'),
    ('twitch.max_custom_rewards', '50', 'Twitch hard cap; enabled column in channel_points controls rollout'),
]

def edit_simulation_config(rows):
    hdr = rows[0]
    existing = {r[0] for r in rows[1:]}
    added = []
    for key, val, note in NEW_CONFIG:
        if key not in existing:
            rows.append([key, val, note])
            added.append(key)
    return [f'simulation_config: +{len(added)} rows'] if added else []

def edit_channel_points(rows):
    hdr = rows[0]
    if 'enabled' not in hdr:
        hdr.append('enabled')
        for r in rows[1:]:
            r.append('yes')
        return ['channel_points: +column enabled (set "no" to skip reward creation for that item; Twitch caps 50 rewards)']
    return []

# ---------------------------------------------------------------- main

def main():
    sheets = read_ods(ODS_PATH)
    changes = []
    changes += edit_items(sheets['items'])
    changes += edit_status_effects(sheets['status_effects'])
    changes += edit_simulation_config(sheets['simulation_config'])
    changes += edit_channel_points(sheets['channel_points'])

    if not changes:
        print('No changes needed (already up to date).')
        return

    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    backup = f'{ODS_PATH}.bak_{stamp}'
    shutil.copy2(ODS_PATH, backup)
    write_ods(ODS_PATH, sheets)

    print(f'Backup: {backup}')
    for c in changes:
        print(f'  {c}')
    print(f'Wrote {ODS_PATH} '
          f'({sum(len(r) for s in sheets.values() for r in s)} rows across {len(sheets)} sheets)')

if __name__ == '__main__':
    main()
