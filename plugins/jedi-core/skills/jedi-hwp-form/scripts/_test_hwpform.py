# -*- coding: utf-8 -*-
"""jedi-hwp-form 결정론 시험 — 한컴 없이 어디서나 돈다(CI 포함).

  python _test_hwpform.py

샘플 = _fixtures/sample.hwpx (한컴으로 만든 1쪽 시험용 문서 — 실제 서류가 아니다).
한컴까지 끝에서 끝으로 돌려보려면 Windows + 한컴에서 HWP_E2E=1 을 켠다.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.stdout.reconfigure(encoding='utf-8')
import hwpx_lib as H

SAMPLE = os.path.join(HERE, '_fixtures', 'sample.hwpx')
FORM = os.path.join(HERE, 'hwpform.py')
fails = []


def check(name, cond, detail=''):
    print('%s %s%s' % ('PASS' if cond else 'FAIL', name, ('  — ' + str(detail)) if not cond else ''))
    if not cond:
        fails.append(name)


def run(*args):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    p = subprocess.run([sys.executable, FORM] + list(args), capture_output=True, env=env)
    return p.returncode, p.stdout.decode('utf-8', 'replace') + p.stderr.decode('utf-8', 'replace')


sec = H.read(SAMPLE, H.SEC0)
hdr = H.read(SAMPLE, 'Contents/header.xml')

# ── 1. 표 안 글자묶음이 바깥 서식으로 새지 않는다 ─────────────────
nested = ('<hp:p id="1"><hp:run charPrIDRef="5"><hp:tbl><hp:tr><hp:tc><hp:subList>'
          '<hp:p id="2"><hp:run charPrIDRef="9"><hp:t>안</hp:t></hp:run>'
          '<hp:linesegarray><hp:lineseg/></hp:linesegarray></hp:p>'
          '</hp:subList></hp:tc></hp:tr></hp:tbl><hp:t>밖</hp:t></hp:run>'
          '<hp:linesegarray><hp:lineseg/></hp:linesegarray></hp:p>')
nodes = {n['inner']: n for n in H.text_nodes(nested)}
check('표 안 글자 서식 = 9', nodes['안']['char_pr'] == '9', nodes['안']['char_pr'])
check('표 뒤 글자 서식 = 5 (표 안 9 가 아니다)', nodes['밖']['char_pr'] == '5', nodes['밖']['char_pr'])

# ── 2. replace_map — 건수 · 이스케이프 · 줄배치 · 긴 것 먼저 ─────
x, c = H.replace_map(nested, {'밖': 'A & B'})
check('replace_map 건수 1', c == {'밖': 1}, c)
check('& 이스케이프', 'A &amp; B' in x)
check('바꾼 문단(바깥) 줄배치만 비움', x.count('<hp:linesegarray/>') == 1
      and x.count('<hp:linesegarray><hp:lineseg/>') == 1, x)
x, c = H.replace_map('<hp:p><hp:run charPrIDRef="0"><hp:t>2026.10.21</hp:t></hp:run></hp:p>',
                     {'2026.10.2': 'X', '2026.10.21': 'Y'})
check('긴 키 먼저 (짧은 키에 먹히지 않음)', c == {'2026.10.21': 1, '2026.10.2': 0}, c)
x, c = H.replace_map('<hp:p><hp:run charPrIDRef="0"><hp:t>a&amp;b <hp:tab width="1"/> c</hp:t>'
                     '</hp:run></hp:p>', {'a&b': 'z', '1': '2'})
check('& 든 찾을 글자 맞음 · 태그 속성 안 건드림', c == {'a&b': 1, '1': 0} and 'width="1"' in x, (c, x))

# ── 3. 날짜 모양 ─────────────────────────────────────────────
for s, want in [('2026.08.05 ~ 2026.10.20', '2026.08.05 ~ 2026.10.20'),
                ('2026. 08. 05. ~ 2026. 10. 20.', '2026. 08. 05. ~ 2026. 10. 20.'),
                ('작성 2026년 10 월  21   일 끝', '2026년 10 월  21   일'),
                ('2026.09.24.~09.29', '2026.09.24.~09.29'),
                ('2026.10.19~20', '2026.10.19~20'),
                ('~2026.08.05', '~2026.08.05'),
                ('2026.  10  .  22  .', '2026.  10  .  22  .')]:
    m = re.search(H.DATE_RE, s)
    check('날짜 모양 %r' % want, m and m.group(0) == want, m and m.group(0))
check('전화번호는 날짜 아님', not re.search(H.DATE_RE, '010-2026-1021'))

# ── 4. color_matches — 그 글자 서식 복제 · 앞뒤 서식 유지 · 다시 돌리면 이미 그 색 ──
x2, h2, hit, al = H.color_matches(sec, hdr, H.DATE_RE)
check('샘플 날짜 3곳 칠함', len(hit) == 3, hit)
H.check_wellformed(s=x2, h=h2)
check('서식 1개 늘어남(itemCnt)', re.search(r'charProperties itemCnt="(\d+)"', h2).group(1)
      == str(int(re.search(r'charProperties itemCnt="(\d+)"', hdr).group(1)) + 1))
new_id = max(int(i) for i in re.findall(r'<hh:charPr id="(\d+)"', h2))
check('새 서식 = 빨강', H.char_color(h2, new_id) == '#DC0000')
base = re.search(r'<hh:charPr id="0"[^>]*>', h2).group(0)
clone = re.search(r'<hh:charPr id="%d"[^>]*>' % new_id, h2).group(0)
check('새 서식 = 원래 서식과 색만 다름',
      re.sub(r'id="\d+"|textColor="[^"]*"', '', base) == re.sub(r'id="\d+"|textColor="[^"]*"', '', clone))
check('날짜 앞 글자는 원래 서식', '<hp:run charPrIDRef="0"><hp:t>작성일: </hp:t></hp:run>' in x2)
x3, h3, hit3, al3 = H.color_matches(x2, h2, H.DATE_RE)
check('다시 돌리면 0곳 칠함 · 3곳 이미 그 색', (len(hit3), len(al3)) == (0, 3), (hit3, al3))

# ── 5. 여백 명시값 ─────────────────────────────────────────────
m = H.get_margins(H.set_margins(sec, top=8, bottom=5))
check('여백 top 8 / bottom 5', round(m['top'], 1) == 8.0 and round(m['bottom'], 1) == 5.0, m)
try:
    H.set_margins(sec, middle=3)
    check('모르는 여백 이름 거부', False)
except KeyError:
    check('모르는 여백 이름 거부', True)

# ── 6. 명령 끝에서 끝 (hwpx → hwpx, 한컴 없이) ─────────────────
tmp = tempfile.mkdtemp(prefix='hwpform-test-')
out = os.path.join(tmp, 'r.hwpx')
rc, o = run('replace', SAMPLE, out, '--set', '홍길동=>김철수', '--set', '옛 회사명=>새 회사')
check('replace exit 0', rc == 0, o)
t = ''.join(H.para_texts(H.read(out, H.SEC0)).values()) if os.path.exists(out) else ''
check('replace 결과에 새 글자 · 옛 글자 없음', '김철수' in t and '홍길동' not in t, t)

out2 = os.path.join(tmp, 'bad.hwpx')
rc, o = run('replace', SAMPLE, out2, '--set', '홍길동=>김철수', '--set', '없는글자=>X')
check('대상 하나라도 0건이면 멈춤(exit≠0) · 파일 안 만듦', rc != 0 and not os.path.exists(out2), o)

rc, o = run('replace', SAMPLE, SAMPLE, '--set', '홍길동=>김철수')
check('원본 덮어쓰기 거부', rc != 0 and '덮어쓸 수 없' in o, o)

# 한 곳은 한 조각, 한 곳은 서식 경계로 「홍 / 길동」 두 조각 → 1건 바뀌어도 옛 글자가 남는다
split_src = os.path.join(tmp, 'split.hwpx')
s2 = sec.replace('<hp:t>끝. 옛 회사명 테스트</hp:t>',
                 '<hp:t>끝. 홍</hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>길동 테스트</hp:t>', 1)
assert s2 != sec
H.save(SAMPLE, split_src, replaced={H.SEC0: s2})
out_s = os.path.join(tmp, 'split-out.hwpx')
rc, o = run('replace', split_src, out_s, '--set', '홍길동=>김철수')
check('조각난 옛 글자 남으면 멈춤', rc != 0 and '옛 글자가 1곳 남음' in o and not os.path.exists(out_s), o)

out3 = os.path.join(tmp, 'c.hwpx')
rc, o = run('color-dates', SAMPLE, out3, '--only', '2026년 10월 21일|2099.01.01')
check('--only 에 없는 날짜가 있으면 멈춤', rc != 0 and '못 찾은 날짜' in o, o)
rc, o = run('color-dates', SAMPLE, out3, '--expect', '3')
check('color-dates --expect 3 통과', rc == 0 and os.path.exists(out3), o)

out4 = os.path.join(tmp, 'm.hwpx')
rc, o = run('margin', SAMPLE, out4, '--top', '8')
check('margin exit 0', rc == 0 and round(H.get_margins(H.read(out4, H.SEC0))['top'], 1) == 8.0, o)

# fill — 칸 주소로 통째 · 여러 줄은 줄마다 문단 · 그림 든 칸 거부(도장 칸)
cells = os.path.join(tmp, 'cells.json')
with open(cells, 'w', encoding='utf-8') as fp:
    json.dump({'1,1': '2026. 11. 01. ~ 2026. 11. 30.', '1,0': '편집\r\n\n둘째 & <줄>'}, fp, ensure_ascii=False)
out5 = os.path.join(tmp, 'f.hwpx')
rc, o = run('fill', SAMPLE, out5, '--cells', cells)
check('fill exit 0', rc == 0, o)
if rc == 0:
    x5 = H.read(out5, H.SEC0)
    sp = H._span_of(x5, 1, 0)
    ps = re.findall(r'<hp:p\b.*?</hp:p>', x5[sp[3]:sp[4]], re.S)
    old_cp = re.search(r'<hp:run charPrIDRef="(\d+)"', sec[H._span_of(sec, 1, 0)[3]:]).group(1)
    check('fill 여러 줄 = 문단 3개(\r\n·\n 같게) · 빈 줄 = 빈 문단', len(ps) == 3 and '<hp:t>' not in ps[1], ps)
    check('fill & < 이스케이프 · 서식 = 그 칸 것',
          '둘째 &amp; &lt;줄&gt;' in ps[2] and all('charPrIDRef="%s"' % old_cp in p for p in ps), ps)
    check('fill 줄배치 비움', all('<hp:linesegarray/>' in p for p in ps), ps)
    check('fill 한 줄 칸', H.cell_text(x5, H._span_of(x5, 1, 1)) == '2026. 11. 01. ~ 2026. 11. 30.')
rc, o = run('fill', SAMPLE, os.path.join(tmp, 'f2.hwpx'), '--set', '9,9=x')
check('fill 없는 칸이면 멈춤', rc != 0 and '칸이 없다' in o and not os.path.exists(os.path.join(tmp, 'f2.hwpx')), o)
pic_src = os.path.join(tmp, 'pic.hwpx')
sp = H._span_of(sec, 1, 1)
i = sec.index('</hp:run>', sp[3])
H.save(SAMPLE, pic_src, replaced={H.SEC0: sec[:i] + H.stamp_node('image99', 4252, 0, 0, 50, 'seal.png') + sec[i:]})
rc, o = run('fill', pic_src, os.path.join(tmp, 'f3.hwpx'), '--set', '1,1=덮어쓰기')
check('fill 그림 든 칸(도장 칸)은 거부 · 파일 안 만듦',
      rc != 0 and '도장' in o and not os.path.exists(os.path.join(tmp, 'f3.hwpx')), o)

# ── 7. 그림 · 도장 자리 · 그림 지우기 · 표 나누기 (XML) ─────────────
def make_png(path, w, h, rgba):
    """표준 라이브러리만으로 단색 PNG — 레포에 그림 파일을 두지 않는다(customer-asset-guard)."""
    import struct
    import zlib

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(rgba) * w for _ in range(h))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
    return path


S2 = os.path.join(HERE, '_fixtures', 'sample2.hwpx')
IMG = [make_png(os.path.join(tmp, 'pic_a.png'), 400, 300, (70, 130, 180, 255)),
       make_png(os.path.join(tmp, 'pic_b.png'), 400, 300, (200, 120, 60, 255))]
STAMP = make_png(os.path.join(tmp, 'stamp.png'), 120, 120, (220, 0, 0, 160))
x2 = H.read(S2, H.SEC0)
hpf2 = H.read(S2, H.HPF)
jpg = os.path.join(tmp, 'h.jpg')
with open(jpg, 'wb') as f:   # 머리만 있는 JPEG — 크기 읽기 시험용 (SOI · APP0 · SOF0)
    f.write(b'\xff\xd8\xff\xe0\x00\x04ab\xff\xc0\x00\x11\x08\x01\x2c\x01\x90' + b'\x00' * 12)
check('그림 크기 읽기 jpg/png', H.image_size(jpg) == (400, 300) and H.image_size(IMG[0]) == (400, 300)
      and H.image_size(STAMP) == (120, 120), (H.image_size(jpg), H.image_size(STAMP)))

px, phpf, adds, n = H.pics_in_cell(x2, hpf2, 1, 0, IMG, cols=2, captions=['① 가', '② 나'])
H.check_wellformed(s=px, h=phpf)
check('pics 2장 · 패키지 등록 2 · 파일 2', n == 2 and len(adds) == 2
      and len(re.findall(r'<opf:item id="image\d+"', phpf)) == len(re.findall(r'<opf:item id="image\d+"', hpf2)) + 2)
check('pics = 1행 2열 표 하나(흐르는 표)', px.count('colCnt="2"') - x2.count('colCnt="2"') == 1
      and 'treatAsChar="1"' in px)
cw = H.cell_box(x2, 1, 0)
w1 = int(re.findall(r'<hp:orgSz width="(\d+)"', px)[-1])
check('그림 폭 = (칸 폭 - 여백 - 2mm) / 2', w1 == (cw[0] - cw[2] - cw[3] - int(2 * H.MM)) // 2, (w1, cw))
check('설명 줄', '① 가    /    ② 나' in px)
try:
    H.pics_in_cell(x2, hpf2, 1, 0, IMG, captions=['하나만'])
    check('설명 수 ≠ 그림 수 거부', False)
except ValueError:
    check('설명 수 ≠ 그림 수 거부', True)

node, off = H.find_text(x2, '(인)')[0]
sx = H.insert_after_text(x2, node, off, '(인)', H.stamp_node('image99', 4252, 1000, 2000, 50, 'stamp.png'))
H.check_wellformed(s=sx)
check('도장 = 「(인)」 문단 안 · 글 앞(떠 있음)', [p['para'][0] for p in H.pic_nodes(sx)] == [node['para'][0]]
      and 'IN_FRONT_OF_TEXT' in sx and '(인)</hp:t></hp:run><hp:run charPrIDRef' in sx)
sx2 = sx.replace('<hp:t>시험용 양식 2</hp:t>', '<hp:t>시험용 양식 2</hp:t></hp:run><hp:run charPrIDRef="0">'
                 + H.stamp_node('image98', 4252, 0, 0, 51, 'other.png'), 1)
dx, gone = H.delete_pics(sx2, '(인)')
check('그림 지우기 = 그 문단 것만', gone == ['stamp.png'] and 'other.png' in dx and 'image99' not in dx, gone)
dx, gone = H.delete_pics(sx, '(인)', name='nope.png')
check('그림 지우기 이름 거름', gone == [])

tb = H.tables(x2)
big = max(tb, key=lambda s: len(H.table_rows(x2[s[0]:s[1]])))
sp, k = H.split_table(x2, big, 8, header=1, start_id=1950000000)
H.check_wellformed(s=sp)
pieces = [sp[a:b] for a, b in H.tables(sp)][1:]
check('표 나누기 21행 → 3개', k == 3 and len(pieces) == 3, k)
check('나눈 표 행 수 9·9·5 (머리 되풀이)', [len(H.table_rows(t)) for t in pieces] == [9, 9, 5])
check('rowCnt 맞음', [re.search(r'rowCnt="(\d+)"', t).group(1) for t in pieces] == ['9', '9', '5'])
check('행 주소 0부터 다시', all(sorted({int(v) for v in re.findall(r'rowAddr="(\d+)"', t)})
                              == list(range(len(H.table_rows(t)))) for t in pieces))
check('둘째 표 첫 본문 = 시험 줄 9', '시험 줄 9 ' in pieces[1] and '시험 줄 8 ' not in pieces[1])
check('표 번호 겹침 없음', len({re.search(r'<hp:tbl id="(\d+)"', t).group(1) for t in pieces}) == 3)
merged = x2[:big[0]] + re.sub(r'(<hp:cellAddr colAddr="0" rowAddr="8"/><hp:cellSpan colSpan="1" rowSpan=")1',
                              r'\g<1>2', x2[big[0]:big[1]], count=1) + x2[big[1]:]
try:
    H.split_table(merged, big, 8)
    check('합쳐진 칸이 자르는 줄을 넘으면 거부', False)
except ValueError as e:
    check('합쳐진 칸이 자르는 줄을 넘으면 거부', '합쳐져' in str(e), e)

rc, o = run('table-split', S2, os.path.join(tmp, 't.hwpx'), '--contains', '번호', '--rows', '8')
check('table-split 명령 exit 0', rc == 0, o)
rc, o = run('pics', S2, os.path.join(tmp, 'p.hwpx'), '--cell', '1,0', '--cols', '2', '--images', *IMG)
check('pics 명령 exit 0 · 그림 파일이 패키지에', rc == 0 and len([
    n for n in __import__('zipfile').ZipFile(os.path.join(tmp, 'p.hwpx')).namelist() if n.startswith('BinData/')]) == 2, o)
rc, o = run('delete-pics', S2, os.path.join(tmp, 'd.hwpx'), '--near', '(인)')
check('지울 그림 0개면 멈춤', rc != 0 and '지울 그림이 없' in o, o)

# ── 8. 검수 — 옛 글자 · 빨간 날짜 · 그림 겹침 (PyMuPDF 로 PDF 를 합성) ───────
try:
    import fitz
except ImportError:
    fitz = None
    print('SKIP 검수 시험 — pymupdf 없음 (pip install pymupdf)')
if fitz:
    sys.path.insert(0, HERE)
    import hwpform as F
    pdf = os.path.join(tmp, 'v.pdf')
    d = fitz.open()
    pg = d.new_page()
    pg.insert_text((72, 72), 'Old Corp 2026.10.21', fontsize=11)
    pg.insert_text((72, 100), '2026.10.22', fontsize=11, color=(220 / 255, 0, 0))
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 20), False)
    pg.insert_image(fitz.Rect(200, 200, 260, 260), pixmap=pix, keep_proportion=False)
    pg.insert_image(fitz.Rect(220, 220, 280, 280), pixmap=pix, keep_proportion=False)
    d.save(pdf)
    probs = F.cmd_verify(pdf, 1, absent=['Old Corp'], expect_red=1)
    check('검수: 옛 글자 남음 잡음', any('옛 글자' in p for p in probs), probs)
    check('검수: 그림 겹침 잡음(도장 두 번)', any('그림 겹침' in p for p in probs), probs)
    check('검수: 빨간 날짜 1곳 = 기대 1 (검정 날짜는 안 셈)', not any('빨간' in p for p in probs), probs)
    probs = F.cmd_verify(pdf, 2, expect_red=2, min_images=3)
    check('검수: 쪽수·빨간 날짜·빠진 그림 불일치 잡음',
          any('쪽수' in p for p in probs) and any('빨간' in p for p in probs)
          and any('빠진 그림' in p for p in probs), probs)
    probs = F.cmd_verify(pdf, present=['Old Corp', 'New Corp'])
    check('검수: 넣은 글자가 PDF 에 없으면 잡음(fill)', any('빠진 글자 1줄' in p for p in probs), probs)
    check('검수: 넣은 글자가 다 있으면 통과', not any('빠진 글자' in p for p in F.cmd_verify(pdf, present=['Old  Corp'])))

    # 반투명 도장은 PDF 에서 가는 띠로 쪼개진다 — 띠 한 묶음은 겹침 아님, 두 묶음이 포개지면 겹침
    def strips(page, x, y):
        for k in range(20):
            page.insert_image(fitz.Rect(x, y + 2 * k, x + 42, y + 2 * k + 2), pixmap=pix, keep_proportion=False)
    one, two = os.path.join(tmp, 's1.pdf'), os.path.join(tmp, 's2.pdf')
    d = fitz.open()
    strips(d.new_page(), 100, 100)
    d.save(one)
    d = fitz.open()
    pg = d.new_page()
    strips(pg, 100, 100)
    strips(pg, 103, 101)
    d.save(two)
    check('검수: 띠로 쪼갠 도장 하나는 겹침 아님', not any('겹침' in p for p in F.cmd_verify(one)))
    check('검수: 띠로 쪼갠 도장 둘이 포개지면 겹침', any('겹침' in p for p in F.cmd_verify(two)))
    c = F._cluster(F._image_rects(one), F._image_rects(one)[0])
    check('띠 묶기 = 도장 하나 크기', abs((c[3] - c[1]) - 42 / 72 * 25.4) < 0.1
          and abs((c[4] - c[2]) - 40 / 72 * 25.4) < 0.1, c)
    # 통그림 + 그 위 타일(한컴 반투명 PNG 모양) = 겹침 아님 · 같은 자리 같은 크기 두 장 = 겹침
    tiles, same = os.path.join(tmp, 't1.pdf'), os.path.join(tmp, 't2.pdf')
    d = fitz.open()
    pg = d.new_page()
    pg.insert_image(fitz.Rect(100, 100, 142, 142), pixmap=pix, keep_proportion=False)
    for i in range(0, 42, 2):
        for j in range(0, 42, 2):
            pg.insert_image(fitz.Rect(100 + i, 100 + j, 102 + i, 102 + j), pixmap=pix, keep_proportion=False)
    d.save(tiles)
    d = fitz.open()
    pg = d.new_page()
    pg.insert_image(fitz.Rect(100, 100, 142, 142), pixmap=pix, keep_proportion=False)
    pg.insert_image(fitz.Rect(100, 100, 142, 142), pixmap=pix, keep_proportion=False)
    d.save(same)
    # 모아찍기(0.707배) — 여백 30mm 문서의 글이 21mm 에서 시작 · 세로 문서가 가로 종이
    shr, wide = os.path.join(tmp, 'shr.pdf'), os.path.join(tmp, 'wide.pdf')
    d = fitz.open()
    d.new_page().insert_text((21.2 / 25.4 * 72, 72), 'text', fontsize=8)
    d.save(shr)
    d = fitz.open()
    d.new_page(width=842, height=595).insert_text((85, 72), 'text', fontsize=8)
    d.save(wide)
    check('검수: 글이 여백보다 왼쪽 = 축소 의심', any('축소' in p for p in F.cmd_verify(shr, expect_left_mm=30)))
    check('검수: 여백 그대로면 축소 아님', not any('축소' in p for p in F.cmd_verify(shr, expect_left_mm=21)))
    check('검수: 세로 문서가 가로 종이 = 모아찍기 의심',
          any('가로' in p for p in F.cmd_verify(wide, expect_portrait=True)))
    check('검수: 통그림 위 타일은 겹침 아님', not any('겹침' in p for p in F.cmd_verify(tiles)))
    check('검수: 같은 자리 같은 크기 두 장 = 겹침', any('겹침' in p for p in F.cmd_verify(same)))

# ── 9. (선택) 한컴 끝에서 끝 — Windows + 한컴 ───────────────────
if os.environ.get('HWP_E2E') == '1':
    import fitz
    out5 = os.path.join(tmp, 'e2e.hwp')
    rc, o = run('color-dates', SAMPLE, out5, '--expect', '3')
    check('E2E color-dates → hwp + pdf + 빨간 날짜 검수', rc == 0 and '빨간 날짜 3곳 (기대 3)' in o, o)
    e1, e2 = os.path.join(tmp, 'e1.hwp'), os.path.join(tmp, 'e2.hwp')
    rc, o = run('pics', S2, e1, '--cell', '1,0', '--cols', '2', '--images', *IMG)
    check('E2E pics', rc == 0, o)
    rc, o = run('stamp', e1, e2, '--after', '(인)', '--image', STAMP)
    check('E2E stamp 0.5mm 안', rc == 0 and '도장 1개' in o, o)
    import hwpform as F
    e2pdf = e2[:-4] + '.pdf'
    an = F._anchor_rects(e2pdf, '(인)')[0]
    small = F._drop_contained([r for r in F._image_rects(e2pdf) if r[3] - r[1] < 20])   # 도장(15mm)
    c = F._cluster(small, min(small, key=lambda r: abs(r[1] - an[1]) + abs(r[2] - an[2])))
    check('E2E 도장 = 15mm · 가운데가 「(인)」 가운데 1mm 안',
          # 가장자리 타일이 0.6mm 쯤 삐져나와 묶음은 15.6mm 로 잡힌다(통그림은 15.0)
          abs(c[3] - c[1] - 15) < 1 and abs((c[1] + c[3]) / 2 - an[1]) < 1 and abs((c[2] + c[4]) / 2 - an[2]) < 1,
          (c, an))
    rc, o = run('stamp', e2, os.path.join(tmp, 'e3.hwp'), '--after', '(inn)', '--image', STAMP)
    check('E2E 없는 글자면 멈춤', rc != 0 and '글자가 없습니다' in o, o)
    rc, o = run('stamp', e2, os.path.join(tmp, 'e3.hwp'), '--after', '(인)', '--image', STAMP)
    check('E2E 같은 도장 두 번이면 멈춤', rc != 0 and '이미 1개' in o, o)
    # 실제 한컴 PDF 에서 도장이 포개진 문서를 verify 가 잡는가 (XML 로 도장을 하나 더 겹쳐 넣는다)
    e2x, dupx, dup = (os.path.join(tmp, n) for n in ('e2.hwpx', 'dup.hwpx', 'dup.hwp'))
    F.convert(e2, e2x)
    sx = H.read(e2x, H.SEC0)
    m = re.search(r'<hp:pic\b.*?</hp:pic>', [x for x in re.findall(r'<hp:pic\b.*?</hp:pic>', sx, re.S)
                                             if 'IN_FRONT_OF_TEXT' in x][0], re.S)
    node = m.group(0)
    node2 = re.sub(r'horzOffset="(\d+)"', lambda mm: 'horzOffset="%d"' % (int(mm.group(1)) + 1000), node, count=1)
    H.save(e2x, dupx, replaced={H.SEC0: sx.replace(node, node + node2, 1)})
    F.convert(dupx, dup, dup[:-4] + '.pdf')
    check('E2E 포개진 도장(한컴 PDF)을 verify 가 잡음',
          any('겹침' in p for p in F.cmd_verify(dup[:-4] + '.pdf')))

print('\n%s — 실패 %d건' % ('OK' if not fails else 'FAIL', len(fails)))
sys.exit(1 if fails else 0)
