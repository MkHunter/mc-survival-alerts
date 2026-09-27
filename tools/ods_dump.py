#!/usr/bin/env python3
"""Dump all sheets of an ODS spreadsheet as TSV. ODS = zip with content.xml (OfficeDocumentSpreadsheet)."""
import sys, zipfile, re
import xml.etree.ElementTree as ET

TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
OFF_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'

def cell_text(p):
    """Concatenate all text:p descendants."""
    return ''.join(t.text or '' for t in p.iter(f'{{{TEXT_NS}}}p'))

def cell_value(c):
    """Handle value-type attribute for numbers/dates."""
    vt = c.get(f'{{{OFF_NS}}}value-type')
    if vt == 'float' or vt == 'percentage':
        v = c.get(f'{{{OFF_NS}}}value')
        if v is not None:
            return v
    elif vt == 'date':
        return c.get(f'{{{OFF_NS}}}date-value', '')
    elif vt == 'boolean':
        return c.get(f'{{{OFF_NS}}}boolean-value', '')
    return cell_text(c)

def main(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read('content.xml')
    root = ET.fromstring(xml)
    body = root.find(f'{{{OFF_NS}}}body')
    spreadsheet = body.find(f'{{{OFF_NS}}}spreadsheet')
    for table in spreadsheet.findall(f'{{{TABLE_NS}}}table'):
        name = table.get(f'{{{TABLE_NS}}}name')
        print(f'===== SHEET: {name} =====')
        for row in table.iter(f'{{{TABLE_NS}}}table-row'):
            # repeat rows
            row_repeat = int(row.get(f'{{{TABLE_NS}}}number-rows-repeated', '1'))
            cells = []
            for cell in row.findall(f'{{{TABLE_NS}}}table-cell'):
                repeat = int(cell.get(f'{{{TABLE_NS}}}number-columns-repeated', '1'))
                val = cell_value(cell)
                for _ in range(min(repeat, 50)):  # cap repeats
                    cells.append(val)
            # strip trailing empties
            while cells and cells[-1] == '':
                cells.pop()
            line = '\t'.join(cells)
            if line.strip():
                for _ in range(min(row_repeat, 5)):
                    print(line)
        print()

if __name__ == '__main__':
    main(sys.argv[1])
