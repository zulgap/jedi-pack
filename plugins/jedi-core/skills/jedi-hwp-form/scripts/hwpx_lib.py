# -*- coding: utf-8 -*-
"""hwpx 편집 라이브러리 — 한컴 없이 한글 문서를 채운다.

.hwpx 는 표준 zip + XML 이라 순수 파이썬으로 편집된다. 한컴(COM)은 양 끝
변환(.hwp -> .hwpx, .hwpx -> .hwp/.pdf)에만 쓴다. 이 파일에는 COM 코드가 없다.

여기 담긴 처방은 전부 실측으로 얻은 것이다. 자세한 근거는 ../PROVENANCE.md.

🔴 다른 방법을 시도하기 전에 알아둘 것 — 아래 두 경로는 실측으로 막혔다:
  · .hwp 를 OLE 재구성으로 직접 쓰기: 파일은 만들어지고 자체 파서로도 읽히는데
    **한글이 열지 못한다**(2종 양식 2/2 거부). 쓰기는 반드시 .hwpx 경유.
  · 단순 문자열 치환(content.replace): 아래 함정 6종이 전부 안 걸러진다.
"""
import os
import re
import zipfile
from xml.sax.saxutils import escape

SEC0 = 'Contents/section0.xml'
SEC1 = 'Contents/section1.xml'
HPF = 'Contents/content.hpf'

MM = 283.46          # 1mm = 283.46 HWPUNIT (도장 4275 = 15.08mm 로 역산 검증)
PX_PER_INCH = 96     # 이미지 픽셀 -> 표시 크기 환산 기준 (아래 pic_node 주석 참조)


# ────────────────────────────────────────────────────────────
# 읽기
# ────────────────────────────────────────────────────────────

def read(path, name):
    """hwpx 안의 XML 한 조각을 문자열로 꺼낸다."""
    with zipfile.ZipFile(path) as z:
        return z.read(name).decode('utf-8')


def sections(path):
    """그 hwpx 가 가진 section XML 이름들 (section0, section1 ...)."""
    with zipfile.ZipFile(path) as z:
        return [n for n in z.namelist()
                if n.startswith('Contents/section') and n.endswith('.xml')]


def cell_spans(xml):
    """[(index, row, col, start, end)] — end 는 <hp:cellAddr> 시작 위치.
    start..end 구간이 그 셀의 내용이다.

    🔴 <hp:tc>...</hp:tc> 짝맞춤으로 세지 말 것 — 표 안에 표가 있으면 어긋난다
    (실측: 65개 중 64개만 잡혀 마지막 칸을 통째로 놓쳤다). cellAddr 은 칸마다
    정확히 하나라 순서가 어긋나지 않는다.
    """
    out = []
    for i, m in enumerate(re.finditer(
            r'<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"\s*/>', xml)):
        start = xml.rfind('<hp:tc', 0, m.start())
        out.append((i, int(m.group(2)), int(m.group(1)), start, m.start()))
    return out


def cell_text(xml, span):
    """그 칸에 보이는 글자 (여러 조각이면 이어붙인다)."""
    return ''.join(re.findall(r'<hp:t>(.*?)</hp:t>', xml[span[3]:span[4]], re.S))


def dump_cells(xml):
    """[(index, row, col, 텍스트, 빈칸인가)] — 양식 조사용."""
    out = []
    for sp in cell_spans(xml):
        seg = xml[sp[3]:sp[4]]
        empty_run = bool(re.search(r'<hp:run charPrIDRef="\d+"\s*/>', seg))
        out.append((sp[0], sp[1], sp[2], cell_text(xml, sp), empty_run))
    return out


def _span_of(xml, row, col, occurrence=0):
    spans = [s for s in cell_spans(xml) if s[1] == row and s[2] == col]
    if not spans:
        raise KeyError('(r%d,c%d) 칸이 없다' % (row, col))
    if occurrence >= len(spans):
        raise KeyError('(r%d,c%d) 는 %d개뿐인데 %d번째를 찾았다 (중첩 표?)'
                       % (row, col, len(spans), occurrence))
    return spans[occurrence]


# ────────────────────────────────────────────────────────────
# 줄배치 (가장 자주 사고 나는 자리)
# ────────────────────────────────────────────────────────────

def clear_lineseg(xml, start, end):
    """[start,end) 구간의 줄배치 정보를 비운다.

    🔴 값을 바꾼 문단은 반드시 이걸 부를 것. 한글은 저장할 때 문단마다 줄배치를
    계산해 파일에 박아두고, 열 때 **그 값을 그대로 믿는다**. 긴 값을 넣고 옛 배치를
    남겨두면 179자가 한 줄에 그려져 칸 밖으로 넘친다(실측). 비우면 다시 계산한다
    (같은 179자가 24줄로 접혔다).

    🔴 반대로 **글자가 없는 빈 문단까지 비우지는 말 것** — 빈 문단의 배치값은 그
    문단의 실제 높이라, 비우면 한글이 기본 높이로 다시 잡아 쪽이 밀릴 수 있다.
    """
    seg = re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>', '<hp:linesegarray/>',
                 xml[start:end], flags=re.S)
    return xml[:start] + seg + xml[end:]


def clear_lineseg_text_paras(xml):
    """글자가 있는 문단만 줄배치를 비운다 (빈 문단은 그대로 둔다)."""
    def f(m):
        p = m.group(0)
        if '<hp:t>' in p:
            p = re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>',
                       '<hp:linesegarray/>', p, flags=re.S)
        return p
    return re.sub(r'<hp:p.*?</hp:p>', f, xml, flags=re.S)


# ────────────────────────────────────────────────────────────
# 칸 채우기 — 상황별로 함수가 다르다
# ────────────────────────────────────────────────────────────

def set_cell(xml, row, col, value, occurrence=0):
    """빈 칸에 값을 넣는다. 이미 글자가 있으면 첫 조각을 갈아끼운다.

    빈 칸에도 <hp:run charPrIDRef="N"/> 이 이미 들어 있어서, 그 태그를 열어
    글자를 넣기만 하면 **양식이 정한 글꼴·크기가 그대로 유지된다**.
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg, v = xml[a:b], escape(value)
    if re.search(r'<hp:run charPrIDRef="\d+"\s*/>', seg):
        new = re.sub(r'<hp:run charPrIDRef="(\d+)"\s*/>',
                     lambda m: '<hp:run charPrIDRef="%s"><hp:t>%s</hp:t></hp:run>'
                               % (m.group(1), v),
                     seg, count=1)
    elif '<hp:t>' in seg:
        new = re.sub(r'<hp:t>.*?</hp:t>', lambda m: '<hp:t>%s</hp:t>' % v,
                     seg, count=1, flags=re.S)
    else:
        raise ValueError('(r%d,c%d): 글자를 넣을 자리가 없다' % (row, col))
    out = xml[:a] + new + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


def set_cell_whole(xml, row, col, value, occurrence=0):
    """칸의 글자를 전부 지우고 value 하나만 남긴다.

    한 칸의 글자가 서식 경계마다 여러 조각으로 갈려 있을 때 쓴다
    (실측: 신청분야 칸 = '붙임3 ; ... 자격요건 ' + '붙임3참조' 2조각).
    부분 치환으로는 양식 안내문이 값 옆에 남는다.
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg, first = xml[a:b], [True]

    def f(m):
        if first[0]:
            first[0] = False
            return '<hp:t>%s</hp:t>' % escape(value)
        return '<hp:t></hp:t>'

    seg = re.sub(r'<hp:t>.*?</hp:t>', f, seg, flags=re.S)
    if first[0]:
        return set_cell(xml, row, col, value, occurrence)
    out = xml[:a] + seg + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


def append_cell(xml, row, col, text, occurrence=0):
    """칸의 마지막 글자 뒤에 이어붙인다 (앞 조각들의 서식을 건드리지 않는다)."""
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    ms = list(re.finditer(r'<hp:t>(.*?)</hp:t>', seg, re.S))
    if not ms:
        return set_cell(xml, row, col, text, occurrence)
    m = ms[-1]
    seg = seg[:m.start()] + '<hp:t>%s%s</hp:t>' % (m.group(1), escape(text)) + seg[m.end():]
    out = xml[:a] + seg + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


def prepend_cell(xml, row, col, text, char_pr, occurrence=0):
    """칸의 맨 앞에 새 글자를 끼운다. 글꼴 서식(char_pr)을 직접 지정한다.

    🔴 칸에 뭔가 보인다고 그게 다 '값'은 아니다. 한글 **메모**(주석)는 파일에는
    글자로 들어 있지만 인쇄되지 않는다 — 즉 그 칸은 사실 빈 칸이다. 메모 글자를
    값으로 착각해 갈아치우면, 넣은 값이 안내문 서식(붉은색)으로 메모 안에 들어가
    **결과물에서 사라진다**(실측). 메모는 두고 본문에 값만 끼울 것.
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    m = re.search(r'<hp:run\b', seg)
    if not m:
        raise ValueError('(r%d,c%d): 글자 자리가 없다' % (row, col))
    ins = '<hp:run charPrIDRef="%s"><hp:t>%s</hp:t></hp:run>' % (char_pr, escape(text))
    out = xml[:a] + seg[:m.start()] + ins + seg[m.start():] + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


def set_cell_content(xml, row, col, inner, occurrence=0):
    """칸 내용을 통째로 갈아끼운다 (사진을 넣을 때 등).

    🔴 안쪽 구조가 복잡한 칸에 부분 치환을 쓰면 파일이 깨진다. 사진 칸은 누름틀
    안에 또 글자 묶음이 있어서, 최소 매칭 정규식이 안쪽에서 멈추고 닫는 태그만
    남는다(실측: 이 때문에 한글이 빈 문서를 열었다).
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    m = re.match(r'(<hp:tc\b[^>]*>)(<hp:subList\b[^>]*>)', seg)
    if not m:
        raise ValueError('(r%d,c%d): 칸 머리를 못 찾았다' % (row, col))
    tail = seg.rfind('</hp:subList>')
    if tail < 0:
        raise ValueError('(r%d,c%d): 칸 끝을 못 찾았다' % (row, col))
    return xml[:a] + m.group(1) + m.group(2) + inner + seg[tail:] + xml[b:]


# ────────────────────────────────────────────────────────────
# 글자 치환 (칸 위치를 몰라도 되는 경우)
# ────────────────────────────────────────────────────────────

def replace_text(xml, find, rep):
    """글자 안에서만 치환하고 **몇 건 바뀌었는지 돌려준다**.

    태그 속성은 건드리지 않는다(전체 문자열 치환은 속성값까지 오염시킨다).
    돌려받은 건수를 기대값과 대조할 것 — 0건이면 조각이 갈렸다는 뜻이다.
    """
    n = [0]

    def sub_t(m):
        inner = m.group(1)
        if find in inner:
            n[0] += inner.count(find)
            inner = inner.replace(find, escape(rep))
        return '<hp:t>%s</hp:t>' % inner

    return re.sub(r'<hp:t>(.*?)</hp:t>', sub_t, xml, flags=re.S), n[0]


def replace_after(xml, anchor, new_text):
    """anchor 가 든 글자조각 **바로 다음 조각**을 통째로 바꾼다.

    양식의 '빈칸'이 별도 조각으로 존재할 때 쓴다 (실측: '위와 같이 201 년도 반기'
    / '          ' / '분야 신지식인...' 3조각 — 가운데 공백이 값을 적는 자리다.
    공백만으로는 그 자리를 유일하게 짚을 수 없다).
    """
    ms = list(re.finditer(r'<hp:t>(.*?)</hp:t>', xml, re.S))
    for i, m in enumerate(ms):
        if anchor in m.group(1) and i + 1 < len(ms):
            n = ms[i + 1]
            return xml[:n.start()] + '<hp:t>%s</hp:t>' % escape(new_text) + xml[n.end():], 1
    raise LookupError('앵커 다음 조각이 없다: %r' % anchor)


# ────────────────────────────────────────────────────────────
# 문단 · 그림
# ────────────────────────────────────────────────────────────

def make_para(text, para_pr, char_pr):
    """새 문단 하나. 줄배치는 넣지 않는다(한글이 계산하게).

    🔴 para_pr / char_pr 은 반드시 **채우려는 그 양식**에서 골라야 한다.
    완성본(다른 도구가 만든 파일)에서 번호를 가져오면 안 된다 — 저장할 때
    서식 번호가 다시 매겨져 같은 번호가 다른 서식을 가리킨다
    (실측: 완성본의 16번은 12pt 인데 양식의 16번은 13pt 라, 그대로 썼더니
    본문이 커지고 줄간격이 같은 비율로 벌어져 쪽수가 하나 늘었다).
    """
    body = ('<hp:run charPrIDRef="%s"><hp:t>%s</hp:t></hp:run>' % (char_pr, escape(text))
            if text else '<hp:run charPrIDRef="%s"/>' % char_pr)
    return ('<hp:p id="0" paraPrIDRef="%s" styleIDRef="0" pageBreak="0" '
            'columnBreak="0" merged="0">%s<hp:linesegarray/></hp:p>' % (para_pr, body))


def char_props(header_xml):
    """{서식번호: {height, color, spacing}} — 어떤 번호를 쓸지 고를 때 본다.
    height 1200 = 12pt. 색이 #000000 이 아니면 안내문용일 수 있다."""
    out = {}
    for m in re.finditer(r'<hh:charPr id="(\d+)"[^>]*height="(\d+)"[^>]*?'
                         r'textColor="([^"]+)"', header_xml):
        cid = m.group(1)
        sp = re.search(r'<hh:charPr id="%s".*?<hh:spacing hangul="(-?\d+)"' % cid,
                       header_xml, re.S)
        out[cid] = {'height': int(m.group(2)), 'color': m.group(3),
                    'spacing': int(sp.group(1)) if sp else None}
    return out


def px_for_mm(mm):
    """목표 mm 로 보이게 하려면 이미지를 몇 픽셀로 줄여야 하나.

    🔴 그림 크기는 <hp:sz> 가 아니라 **이미지의 픽셀 수**가 정한다(종이 기준으로
    붙인 그림에서 실측). 152px 짜리 도장에 15.1mm 를 지정했는데 40.3mm 로 그려졌고,
    그 값은 152 / 96dpi = 40.2mm 와 일치했다. 그래서 넣기 전에 미리 줄여야 한다.
    '원본 해상도를 살려 인쇄 품질을 올린다' 는 성립하지 않는다.
    """
    return max(1, round(mm / 25.4 * PX_PER_INCH))


def pic_node(img_id, w, h, orig_w, orig_h, treat_as_char, vert_rel, horz_rel,
             vert_off=0, horz_off=0, clip=(0, 0, 0, 0), z=3, name=''):
    """그림 하나. 길이 단위는 전부 HWPUNIT (1mm = 283.46).

    treat_as_char=1  : 글자처럼 취급 — 칸 안에 넣는 사진
    treat_as_char=0  : 글과 무관하게 떠 있음 — 도장처럼 얹는 것
    vert_rel/horz_rel: 'PAPER'(종이) | 'PARA'(문단) | 'COLUMN'(단)

    🔴 종이 기준(PAPER)이라도 **본문 문단에 붙이면 좌표가 여백 기준으로 읽힌다**
    (실측: 172.7mm 를 줬는데 197.6mm 에 그려졌고 차이가 정확히 왼쪽 여백이었다).
    표 안 문단에 붙였을 때는 그대로 맞았다. 결과 PDF 로 재서 차이만큼 빼줄 것.
    """
    cl, cr, ct, cb = clip
    return (
        '<hp:pic id="%d" zOrder="%d" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" '
        'textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" '
        'instid="%d" reverse="0">'
        '<hp:offset x="0" y="0"/><hp:orgSz width="%d" height="%d"/>'
        '<hp:curSz width="0" height="0"/><hp:flip horizontal="0" vertical="0"/>'
        '<hp:rotationInfo angle="0" centerX="%d" centerY="%d" rotateimage="1"/>'
        '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
        '<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
        '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'
        '<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="%d" y="0"/><hc:pt2 x="%d" y="%d"/>'
        '<hc:pt3 x="0" y="%d"/></hp:imgRect>'
        '<hp:imgClip left="%d" right="%d" top="%d" bottom="%d"/>'
        '<hp:inMargin left="0" right="0" top="0" bottom="0"/>'
        '<hc:img binaryItemIDRef="%s" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>'
        '<hp:effects/>'
        '<hp:sz width="%d" widthRelTo="ABSOLUTE" height="%d" heightRelTo="ABSOLUTE" protect="0"/>'
        '<hp:pos treatAsChar="%d" affectLSpacing="0" flowWithText="1" allowOverlap="0" '
        'holdAnchorAndSO="0" vertRelTo="%s" horzRelTo="%s" vertAlign="TOP" horzAlign="LEFT" '
        'vertOffset="%d" horzOffset="%d"/>'
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
        '<hp:shapeComment>그림입니다.\n원본 그림의 이름: %s</hp:shapeComment></hp:pic>'
        % (1162460000 + z, z, 88719000 + z, orig_w, orig_h, orig_w // 2, orig_h // 2,
           orig_w, orig_w, orig_h, orig_h, cl, cr, ct, cb, img_id,
           w, h, treat_as_char, vert_rel, horz_rel, vert_off, horz_off, name))


def pic_table(items, tbl_id, z=3, border_fill='2', char_pr='9', para_pr='0'):
    """그림을 담은 **1행 N열 표**를 만든다. items = [(pic_xml, w, h)] (HWPUNIT).

    🔴 문단에 직접 붙인 그림은 **이미지의 픽셀 수**가 크기를 정한다 — `<hp:sz>`,
    `<hp:orgSz>`, 이미지 DPI 메타데이터가 **셋 다 무시**된다(실측). 그래서 크기를
    맞추려면 픽셀을 줄여야 하고 결과가 96dpi 라 인쇄하면 거칠다.
    **표 셀 안에서는 셀 크기가 표시 크기를 정한다** — 원본 1025px 을 그대로 넣어도
    110mm 로 잡혔다(96 → 237dpi). 그림은 되도록 이 함수로 감싸 넣을 것.

    🔴 옛 그림 노드를 지우는 순서에 주의 — 표를 먼저 끼우면 표 **안**의 그림이 같은
    binaryItemIDRef 라, 뒤이은 삭제가 방금 넣은 것을 지운다. 옛 노드를 먼저 걷어낼 것.

    예외: 도장처럼 글자 **옆**에 놓아야 하는 그림은 표로 감싸면 나란히 못 놓는다.
    """
    if not items:
        raise ValueError('items 가 비었다')
    tw = sum(w for _, w, _ in items)
    th = max(h for _, _, h in items)
    tcs = []
    for k, (pic, w, _h) in enumerate(items):
        tcs.append(
            '<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" '
            'borderFillIDRef="%s"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" '
            'vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" '
            'textHeight="0" hasTextRef="0" hasNumRef="0">'
            '<hp:p id="0" paraPrIDRef="%s" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'
            '<hp:run charPrIDRef="%s">%s</hp:run><hp:linesegarray/></hp:p></hp:subList>'
            '<hp:cellAddr colAddr="%d" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>'
            '<hp:cellSz width="%d" height="%d"/>'
            '<hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>'
            % (border_fill, para_pr, char_pr, pic, k, w, th))
    return ('<hp:tbl id="%d" zOrder="%d" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" '
            'textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" '
            'rowCnt="1" colCnt="%d" cellSpacing="0" borderFillIDRef="%s" noAdjust="0">'
            '<hp:sz width="%d" widthRelTo="ABSOLUTE" height="%d" heightRelTo="ABSOLUTE" protect="0"/>'
            '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" '
            'holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" '
            'horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
            '<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
            '<hp:inMargin left="0" right="0" top="0" bottom="0"/>'
            '<hp:tr>%s</hp:tr></hp:tbl>'
            % (tbl_id, z, len(items), border_fill, tw, th, ''.join(tcs)))


def anchor_pic_first_para(xml, pic_xml, char_pr='0'):
    """그림을 **문서 첫 문단**에 매단다.

    🔴 마지막 문단에 매달면 빈 쪽이 생긴다. 종이 기준 절대좌표라 그려지는 위치는
    같은데도 그렇다 — 한글이 그 문단 뒤에 그림 자리를 잡으려 하기 때문으로 보인다
    (실측: 여백·그림속성·좌표가 전부 같은 상태에서 매다는 문단만 바꿔 1쪽 <-> 2쪽).
    """
    p = xml.find('<hp:p ')
    if p < 0:
        raise ValueError('문단이 없다')
    end = xml.find('</hp:p>', p)
    seg = xml[p:end]
    i = seg.rfind('</hp:run>')
    if i < 0:
        raise ValueError('첫 문단에 글자 묶음이 없다')
    ins = '<hp:run charPrIDRef="%s">%s</hp:run>' % (char_pr, pic_xml)
    return xml[:p] + seg[:i + 9] + ins + seg[i + 9:] + xml[end:]


def anchor_pic_in_cell(xml, row, col, pic_xml, char_pr='0', occurrence=-1):
    """그림을 특정 칸의 마지막 문단에 매단다 (표 안 앵커)."""
    spans = [s for s in cell_spans(xml) if s[1] == row and s[2] == col]
    if not spans:
        raise KeyError('(r%d,c%d) 칸이 없다' % (row, col))
    _, _, _, a, b = spans[occurrence]
    p = xml.rfind('<hp:p ', a, b)
    if p < 0:
        raise ValueError('(r%d,c%d): 문단이 없다' % (row, col))
    end = xml.find('</hp:p>', p)
    seg = xml[p:end]
    i = seg.rfind('</hp:run>')
    if i < 0:
        raise ValueError('(r%d,c%d): 글자 묶음이 없다' % (row, col))
    ins = '<hp:run charPrIDRef="%s">%s</hp:run>' % (char_pr, pic_xml)
    return xml[:p] + seg[:i + 9] + ins + seg[i + 9:] + xml[end:]


# ────────────────────────────────────────────────────────────
# 여백 · 저장
# ────────────────────────────────────────────────────────────

def get_margins(xml):
    """{top, bottom, left, right, header, footer} — 단위 mm."""
    m = re.search(r'<hp:margin([^>]*)/>', xml)
    if not m:
        return {}
    return {k: int(v) / MM for k, v in re.findall(r'(\w+)="(\d+)"', m.group(1))}


def set_margin(xml, which, mm_value):
    """여백 한 변을 mm 로 지정한다 (도장이 쪽을 밀 때 아래 여백을 줄이는 등)."""
    return re.sub(r'(<hp:margin[^>]*?)%s="\d+"' % which,
                  lambda m: '%s%s="%d"' % (m.group(1), which, round(mm_value * MM)),
                  xml, count=1)


def register_image(hpf, img_id, href, media='image/jpg'):
    """content.hpf 목록에 그림 하나를 등록한다. 그림 등록은 여기 한 곳뿐이다."""
    if 'id="%s"' % img_id in hpf:
        return hpf
    item = '<opf:item id="%s" href="%s" media-type="%s" isEmbeded="1"/>' % (img_id, href, media)
    return hpf.replace('<opf:manifest>', '<opf:manifest>' + item, 1)


def check_wellformed(**docs):
    """저장 전 XML 이 깨지지 않았는지 본다.

    🔴 반드시 부를 것. 깨진 채 넘기면 한글이 **아무 말 없이 빈 문서를 연다**
    (실측: Open 이 False 를 주고 1쪽짜리 빈 문서가 열렸다. 예외도 경고도 없었다).
    """
    from xml.etree import ElementTree as ET
    for name, doc in docs.items():
        try:
            ET.fromstring(doc)
        except Exception as e:
            raise AssertionError('%s XML 이 깨졌다: %s' % (name, e))
    return True


def save(src_hwpx, dst_hwpx, replaced=None, add_files=None):
    """편집한 XML 과 새 그림을 넣어 새 hwpx 로 저장한다.

    replaced : {zip 안 경로: 새 내용(str 또는 bytes)}
    add_files: {zip 안 경로: 로컬 파일 경로}
    """
    replaced = {k: (v.encode('utf-8') if isinstance(v, str) else v)
                for k, v in (replaced or {}).items()}
    add_files = add_files or {}
    zin = zipfile.ZipFile(src_hwpx)
    names = zin.namelist()
    if os.path.exists(dst_hwpx):
        os.remove(dst_hwpx)
    zout = zipfile.ZipFile(dst_hwpx, 'w', zipfile.ZIP_DEFLATED)
    # mimetype 은 맨 앞 + 압축하지 않음 (zip 규약)
    if 'mimetype' in names:
        zout.writestr(zipfile.ZipInfo('mimetype'), zin.read('mimetype'), zipfile.ZIP_STORED)
    for n in names:
        if n == 'mimetype':
            continue
        zout.writestr(n, replaced.get(n, zin.read(n)))
    for arc, local in add_files.items():
        with open(local, 'rb') as f:
            zout.writestr(arc, f.read())
    zout.close()
    zin.close()
    return dst_hwpx
